/**
 * Read-only wrappers for service/{tafseer,hadeeth,trajim}.db.
 * Per `docs/catalog-survey.md` §7.
 *
 * Each service DB has the schema:
 *   service(key_id INTEGER, book_id INTEGER, page_id INTEGER)
 *   inservice(book INTEGER, user_excluded INTEGER)
 *
 * Lookup: given a key_id (e.g. an aya_id for tafseer), return all
 * (book_id, page_id) pairs. We don't filter on `user_excluded` since
 * we don't expose the user-exclusion toggle.
 */

import * as path from "node:path";

import type { ShamelaDb, SqlDatabase } from "./db.js";

export type ServiceName = "tafseer" | "hadeeth" | "trajim";

export interface ServiceHit {
    book_id: number;
    page_id: number;
}

export class ServiceStore {
    private readonly databases = new Map<ServiceName, SqlDatabase>();
    /**
     * Service handles are held for the process lifetime with no eviction, so a
     * download that rewrites e.g. tafseer.db would otherwise be invisible for
     * the rest of the session. Generation-stamped like the page store: stale
     * handles are dropped on next use, not closed in a batch.
     */
    private generation = 0;
    private readonly handleGeneration = new Map<ServiceName, number>();

    constructor(
        private readonly databaseRoot: string,
        private readonly db: ShamelaDb,
    ) {}

    private servicePath(name: ServiceName): string {
        return path.join(this.databaseRoot, "service", `${name}.db`);
    }

    /** Drop cached service handles; the next read re-opens from disk. */
    invalidate(): void {
        this.generation++;
    }

    private async getDb(name: ServiceName): Promise<SqlDatabase | null> {
        const cached = this.databases.get(name);
        if (cached) {
            if ((this.handleGeneration.get(name) ?? 0) === this.generation) return cached;
            this.databases.delete(name);
            this.handleGeneration.delete(name);
            try {
                cached.close();
            } catch {
                /* ignore */
            }
        }
        const p = this.servicePath(name);
        try {
            const db = await this.db.open(p);
            if (!db) return null;
            this.databases.set(name, db);
            this.handleGeneration.set(name, this.generation);
            return db;
        } catch {
            // An unreadable service index is the same as a missing one here:
            // the caller loses that lookup, not the whole request.
            return null;
        }
    }

    /** Return all (book_id, page_id) pairs indexed for `key_id` in service `name`. */
    async getBooksForKey(name: ServiceName, keyId: number): Promise<ServiceHit[]> {
        const db = await this.getDb(name);
        if (!db) return [];
        const stmt = db.prepare(
            "SELECT book_id, page_id FROM service WHERE key_id = ? ORDER BY page_id",
        );
        try {
            stmt.bind([keyId]);
            const out: ServiceHit[] = [];
            while (stmt.step()) {
                const r = stmt.get();
                out.push({ book_id: r[0] as number, page_id: r[1] as number });
            }
            return out;
        } finally {
            stmt.free();
        }
    }

    /**
     * True when the service table holds no rows at all.
     *
     * A key that resolves to nothing has two very different causes — this key
     * is not in the index, or the index has nothing in it — and the error for
     * the first is a wrong diagnosis of the second. Cached per service: an
     * index does not go from populated to empty mid-session.
     */
    private emptyCache = new Map<ServiceName, boolean>();
    async isEmpty(name: ServiceName): Promise<boolean> {
        const cached = this.emptyCache.get(name);
        if (cached !== undefined) return cached;
        const db = await this.getDb(name);
        let empty = true;
        if (db) {
            const stmt = db.prepare("SELECT 1 FROM service LIMIT 1");
            try {
                empty = !stmt.step();
            } finally {
                stmt.free();
            }
        }
        this.emptyCache.set(name, empty);
        return empty;
    }

    /** Return books participating in this service (downloaded books that contribute key→page pairs). */
    async listInService(name: ServiceName): Promise<number[]> {
        const db = await this.getDb(name);
        if (!db) return [];
        const stmt = db.prepare("SELECT book FROM inservice WHERE user_excluded = 0");
        try {
            const out: number[] = [];
            while (stmt.step()) out.push(stmt.get()[0] as number);
            return out;
        } finally {
            stmt.free();
        }
    }

    close(): void {
        for (const db of this.databases.values()) {
            try {
                db.close();
            } catch {
                /* ignore */
            }
        }
        this.databases.clear();
    }
}

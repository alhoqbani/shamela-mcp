/**
 * Read-only sql.js wrappers for service/{tafseer,hadeeth,trajim}.db.
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

import * as fs from "node:fs";
import * as path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

export type ServiceName = "tafseer" | "hadeeth" | "trajim";

export interface ServiceHit {
    book_id: number;
    page_id: number;
}

export class ServiceStore {
    private SQL: SqlJsStatic | null = null;
    private readonly databases = new Map<ServiceName, Database>();

    constructor(
        private readonly databaseRoot: string,
        private readonly wasmBinary: Uint8Array,
    ) {}

    private async ensureInit(): Promise<SqlJsStatic> {
        if (this.SQL) return this.SQL;
        const buf = this.wasmBinary;
        const ab: ArrayBuffer =
            buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
                ? (buf.buffer as ArrayBuffer)
                : (buf.slice().buffer as ArrayBuffer);
        this.SQL = await initSqlJs({ wasmBinary: ab });
        return this.SQL;
    }

    private servicePath(name: ServiceName): string {
        return path.join(this.databaseRoot, "service", `${name}.db`);
    }

    private async getDb(name: ServiceName): Promise<Database | null> {
        const cached = this.databases.get(name);
        if (cached) return cached;
        const p = this.servicePath(name);
        if (!fs.existsSync(p)) return null;
        const SQL = await this.ensureInit();
        try {
            const db = new SQL.Database(new Uint8Array(fs.readFileSync(p)));
            this.databases.set(name, db);
            return db;
        } catch {
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

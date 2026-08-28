/**
 * Keeping the in-memory catalog in step with a library that changes underneath.
 *
 * The catalog is read once at startup. That was fine while a session meant "the
 * library as it was when Claude Desktop launched", but the whole point of
 * telling a researcher which book to download is that they go and download it —
 * and until now the extension could not see the book it had just recommended.
 *
 * Shamela rewrites `master.db` when it registers a download, so its mtime and
 * size are the signal. Deliberately conservative:
 *   - Checks at most once every couple of seconds; the model fires several tool
 *     calls a second and the human loop it is watching for takes far longer.
 *   - Never throws. A reload can fail because Shamela is mid-write, and a
 *     failed refresh must not turn an unrelated request into an error — the
 *     previous catalog is a consistent snapshot and stays in use.
 *   - Backs off after a failure so a permanently broken file is not retried on
 *     every call.
 */

import * as fs from "node:fs";

import { Catalog } from "./catalog.js";
import type { ShamelaDb } from "./db.js";
import { DiskIndex } from "./diskIndex.js";

export interface FreshnessStats {
    checks: number;
    reloads: number;
    failures: number;
    consecutive_failures: number;
    last_reload_at: number | null;
    last_failure_message: string | null;
}

const CHECK_INTERVAL_MS = 2_000;
const FAIL_BACKOFF_MS = 30_000;
/** A torn read is cheap to detect and cheap to retry; give up quickly. */
const TORN_READ_RETRIES = 2;

interface Fingerprint {
    mtimeMs: number;
    size: number;
}

function fingerprint(file: string): Fingerprint | null {
    try {
        const st = fs.statSync(file);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return null;
    }
}

function sameFingerprint(a: Fingerprint | null, b: Fingerprint | null): boolean {
    if (!a || !b) return false;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class CatalogFreshness {
    private readonly masterDbPath: string;
    private readonly databaseRoot: string;
    private readonly db: ShamelaDb;
    private readonly now: () => number;
    private readonly checkIntervalMs: number;
    private readonly failBackoffMs: number;
    private readonly log: (msg: string) => void;

    private lastCheckAt = 0;
    private lastFailureAt = 0;
    private lastSeen: Fingerprint | null = null;
    private reloadPromise: Promise<Catalog> | null = null;
    private stats_: FreshnessStats = {
        checks: 0,
        reloads: 0,
        failures: 0,
        consecutive_failures: 0,
        last_reload_at: null,
        last_failure_message: null,
    };

    constructor(opts: {
        masterDbPath: string;
        databaseRoot: string;
        db: ShamelaDb;
        now?: () => number;
        checkIntervalMs?: number;
        failBackoffMs?: number;
        /** Diagnostics sink; the server passes its stderr logger. */
        log?: (msg: string) => void;
    }) {
        this.masterDbPath = opts.masterDbPath;
        this.databaseRoot = opts.databaseRoot;
        this.db = opts.db;
        this.now = opts.now ?? Date.now;
        this.checkIntervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
        this.failBackoffMs = opts.failBackoffMs ?? FAIL_BACKOFF_MS;
        this.log = opts.log ?? (() => {});
        this.lastSeen = fingerprint(this.masterDbPath);
    }

    stats(): FreshnessStats {
        return { ...this.stats_ };
    }

    /**
     * Return the current catalog, reloading first if the library changed.
     * Returns the very same instance when nothing changed, so callers can
     * compare by identity to decide whether to drop their caches.
     */
    async ensureFresh(current: Catalog, force = false): Promise<Catalog> {
        if (this.reloadPromise) {
            // A reload is already running; join it rather than starting a second.
            try {
                return await this.reloadPromise;
            } catch {
                return current;
            }
        }

        const now = this.now();
        const backedOff =
            this.stats_.consecutive_failures > 0 && now - this.lastFailureAt < this.failBackoffMs;
        if (!force && (now - this.lastCheckAt < this.checkIntervalMs || backedOff)) return current;

        this.lastCheckAt = now;
        this.stats_.checks++;

        const seen = fingerprint(this.masterDbPath);
        if (sameFingerprint(seen, this.lastSeen)) return current;
        if (!seen) return current; // file momentarily unavailable — keep what we have

        this.reloadPromise = this.reload(current, seen);
        try {
            return await this.reloadPromise;
        } catch {
            return current;
        } finally {
            this.reloadPromise = null;
        }
    }

    private async reload(current: Catalog, seen: Fingerprint): Promise<Catalog> {
        for (let attempt = 0; attempt <= TORN_READ_RETRIES; attempt++) {
            const before = fingerprint(this.masterDbPath);
            try {
                const idx = new DiskIndex(this.databaseRoot);
                idx.scan();
                const next = await Catalog.load(this.masterDbPath, this.db, {
                    databaseRoot: this.databaseRoot,
                    diskIndex: idx,
                });
                const after = fingerprint(this.masterDbPath);
                if (!sameFingerprint(before, after)) continue; // written while we read

                // Anything on disk now that the previous catalog did not have is
                // new to this session, so the helper's Lucene readers do not
                // know it yet.
                next.adoptSessionDiscovered(current);
                const appeared: number[] = [];
                for (const id of next.downloadedBookIds()) {
                    if (!current.isDownloaded(id)) appeared.push(id);
                }
                next.markSessionDiscovered(appeared);

                this.lastSeen = after ?? seen;
                this.stats_.reloads++;
                this.stats_.consecutive_failures = 0;
                this.stats_.last_reload_at = this.now();
                this.log(
                    `catalog reloaded: ${next.bookCount()} books, ${next.downloadedBookIds().size} on disk` +
                        (appeared.length ? `, ${appeared.length} new this session` : ""),
                );
                return next;
            } catch (err) {
                if (attempt < TORN_READ_RETRIES) continue;
                this.stats_.failures++;
                this.stats_.consecutive_failures++;
                this.lastFailureAt = this.now();
                this.stats_.last_failure_message = err instanceof Error ? err.message : String(err);
                this.log(
                    `catalog reload failed (${this.stats_.consecutive_failures} in a row); ` +
                        `keeping the previous snapshot: ${this.stats_.last_failure_message}`,
                );
                throw err;
            }
        }
        // Every attempt saw the file change mid-read; try again on a later call.
        return current;
    }
}

/**
 * Per-book SQLite reader for printed-page labels. Lazy-opens up to 50 books
 * via sql.js (each DB is loaded into memory once and kept resident; per-book
 * DBs are 30-100 KB so this fits comfortably).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

const CACHE_LIMIT = 50;
const BOOK_LITERAL = "الكتاب"; // when part == "الكتاب", we treat it as no part

export class PageStore {
    private SQL: SqlJsStatic | null = null;
    private readonly databases = new Map<number, Database>();

    constructor(private readonly databaseRoot: string, private readonly wasmBinary: Uint8Array) {}

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

    private bookPath(bookId: number): string {
        const bucket = bookId % 1000;
        return path.join(this.databaseRoot, "book", String(bucket), `${bookId}.db`);
    }

    private async getDb(bookId: number): Promise<Database | null> {
        const cached = this.databases.get(bookId);
        if (cached) {
            // Touch (LRU): re-insert so iteration order = least->most recent.
            this.databases.delete(bookId);
            this.databases.set(bookId, cached);
            return cached;
        }
        const p = this.bookPath(bookId);
        if (!fs.existsSync(p)) return null;
        const SQL = await this.ensureInit();
        let db: Database;
        try {
            db = new SQL.Database(new Uint8Array(fs.readFileSync(p)));
        } catch {
            return null;
        }
        this.databases.set(bookId, db);
        if (this.databases.size > CACHE_LIMIT) {
            const oldestKey = this.databases.keys().next().value;
            if (oldestKey !== undefined) {
                const oldest = this.databases.get(oldestKey);
                this.databases.delete(oldestKey);
                try {
                    oldest?.close();
                } catch {
                    /* ignore */
                }
            }
        }
        return db;
    }

    async printedPage(bookId: number, pageId: number): Promise<string | null> {
        const db = await this.getDb(bookId);
        if (!db) return null;
        const stmt = db.prepare("SELECT part, page FROM page WHERE id = ?");
        try {
            stmt.bind([pageId]);
            if (!stmt.step()) return null;
            const row = stmt.get();
            const part = typeof row[0] === "string" ? row[0].trim() : "";
            const pageVal = row[1];
            const pageStr = typeof pageVal === "number" ? String(pageVal) : "";
            if (part && part !== BOOK_LITERAL) {
                return pageStr ? `${part}/ ${pageStr}` : part;
            }
            return pageStr || null;
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

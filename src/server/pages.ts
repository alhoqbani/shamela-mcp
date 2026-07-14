/**
 * Per-book SQLite reader. LRU cache of up to 50 sql.js Database handles
 * per `docs/architecture.md` §"SQLite cache strategy".
 *
 * Surface:
 *   getPageRow(book_id, page_id)        — { part, page, number, services }
 *   getPagesRows(book_id, page_ids[])   — batch lookup
 *   getPagesRange(book_id, start_id, count) — N consecutive pages
 *   getToc(book_id, parent_id?, depth?) — TOC subtree
 *   getAncestorChain(book_id, page_id)  — root → page chapter chain
 *   getSection(book_id, title_id)       — page range under a chapter title
 *   getBookParts(book_id)               — distinct parts + page counts
 *   getPageServices(book_id, page_id)   — parsed services JSON
 */

import * as fs from "node:fs";
import * as path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import { PER_BOOK_CACHE_LIMIT } from "./constants.js";

const BOOK_LITERAL = "الكتاب"; // when part == "الكتاب", we treat it as no part

/** Format a page's printed-page label (e.g. "3/ 512") from its row. */
function formatPrintedPage(row: PageRow): string | null {
    const part = row.part?.trim() ?? "";
    const pageStr = row.page !== null ? String(row.page) : "";
    if (part && part !== BOOK_LITERAL) {
        return pageStr ? `${part}/ ${pageStr}` : part;
    }
    return pageStr || null;
}

export interface PageRow {
    page_id: number;
    part: string | null;
    page: number | null;
    number: number | null;
    services_raw: string | null;
}

export interface TocEntry {
    title_id: number;
    page_id: number;
    parent_id: number;
    has_children: boolean;
    children?: TocEntry[];
}

export interface SectionPageRange {
    title_id: number;
    parent_id: number;
    start_page_id: number;
    end_page_id: number; // inclusive
    total_pages: number;
}

export interface BookPart {
    part: string;
    page_count: number;
    first_page_id: number;
    last_page_id: number;
}

export interface PageServices {
    ayat?: number[];
    hadeeth?: number[];
    esnad?: string[];
    /** Anything else Shamela may have added. Kept as raw JSON for future fields. */
    raw?: unknown;
}

export class PageStore {
    private SQL: SqlJsStatic | null = null;
    private readonly databases = new Map<number, Database>();

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

    private bookPath(bookId: number): string {
        const bucket = bookId % 1000;
        return path.join(this.databaseRoot, "book", String(bucket), `${bookId}.db`);
    }

    private async getDb(bookId: number): Promise<Database | null> {
        const cached = this.databases.get(bookId);
        if (cached) {
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
        if (this.databases.size > PER_BOOK_CACHE_LIMIT) {
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

    /** True if the per-book DB exists on disk (book is downloaded). */
    async hasBook(bookId: number): Promise<boolean> {
        return fs.existsSync(this.bookPath(bookId));
    }

    /**
     * True iff the per-book DB exists AND has at least one page row. Bug #3:
     * `master.db.book.major_ondisk > 0` flips before the per-book SQLite is
     * populated, so the catalog flag alone misreports books as "downloaded"
     * when content lookups still fail. Use this for any user-facing
     * `downloaded` field.
     */
    async bookHasContent(bookId: number): Promise<boolean> {
        if (!(await this.hasBook(bookId))) return false;
        return (await this.pageCount(bookId)) > 0;
    }

    async printedPage(bookId: number, pageId: number): Promise<string | null> {
        const row = await this.getPageRow(bookId, pageId);
        if (!row) return null;
        return formatPrintedPage(row);
    }

    /**
     * Batch variant of printedPage (perf, #24 — kills the N+1 in
     * search enrichment): one SQLite query per book instead of one per hit.
     */
    async printedPages(bookId: number, pageIds: number[]): Promise<Map<number, string | null>> {
        const rows = await this.getPagesRows(bookId, pageIds);
        const out = new Map<number, string | null>();
        rows.forEach((row, i) => {
            out.set(pageIds[i]!, row ? formatPrintedPage(row) : null);
        });
        return out;
    }

    async getPageRow(bookId: number, pageId: number): Promise<PageRow | null> {
        const db = await this.getDb(bookId);
        if (!db) return null;
        const stmt = db.prepare(
            "SELECT id, part, page, number, services FROM page WHERE id = ?",
        );
        try {
            stmt.bind([pageId]);
            if (!stmt.step()) return null;
            const r = stmt.get();
            return rowToPage(r);
        } finally {
            stmt.free();
        }
    }

    async getPagesRows(bookId: number, pageIds: number[]): Promise<Array<PageRow | null>> {
        if (!pageIds.length) return [];
        const db = await this.getDb(bookId);
        if (!db) return pageIds.map(() => null);
        // Batch via IN clause — sqlite handles large IN lists well.
        const placeholders = pageIds.map(() => "?").join(",");
        const stmt = db.prepare(
            `SELECT id, part, page, number, services FROM page WHERE id IN (${placeholders})`,
        );
        const byId = new Map<number, PageRow>();
        try {
            stmt.bind(pageIds);
            while (stmt.step()) {
                const row = rowToPage(stmt.get());
                byId.set(row.page_id, row);
            }
        } finally {
            stmt.free();
        }
        return pageIds.map((id) => byId.get(id) ?? null);
    }

    /** Read N consecutive pages by id starting at start_id (inclusive). */
    async getPagesRange(
        bookId: number,
        startPageId: number,
        count: number,
    ): Promise<PageRow[]> {
        const db = await this.getDb(bookId);
        if (!db) return [];
        const stmt = db.prepare(
            "SELECT id, part, page, number, services FROM page WHERE id >= ? ORDER BY id LIMIT ?",
        );
        try {
            stmt.bind([startPageId, count]);
            const out: PageRow[] = [];
            while (stmt.step()) out.push(rowToPage(stmt.get()));
            return out;
        } finally {
            stmt.free();
        }
    }

    /** Total pages in a book (max id). */
    async pageCount(bookId: number): Promise<number> {
        const db = await this.getDb(bookId);
        if (!db) return 0;
        const stmt = db.prepare("SELECT MAX(id) FROM page");
        try {
            if (stmt.step()) return (stmt.get()[0] as number) ?? 0;
            return 0;
        } finally {
            stmt.free();
        }
    }

    /**
     * Read a TOC subtree under `parent_id` to depth `depth` (default 1).
     * The `title/` Lucene index has the title text; this method returns
     * structural data only. Callers join with Java's `get_titles_batch`
     * to attach the Arabic chapter labels.
     */
    async getToc(
        bookId: number,
        parentId: number = 0,
        depth: number = 1,
    ): Promise<TocEntry[]> {
        const db = await this.getDb(bookId);
        if (!db) return [];
        return collectToc(db, parentId, Math.max(1, Math.min(depth, 5)));
    }

    /**
     * Walk the title tree from root to the title that owns `pageId`. Returns
     * the chain of (title_id, parent_id, page_id) entries, root → leaf.
     */
    async getAncestorChain(bookId: number, pageId: number): Promise<TocEntry[]> {
        const db = await this.getDb(bookId);
        if (!db) return [];
        // Find the most-specific title whose page <= pageId (largest such id).
        const findStmt = db.prepare(
            "SELECT id, page, parent FROM title WHERE page <= ? ORDER BY id DESC LIMIT 1",
        );
        let leafTitleId: number | null = null;
        try {
            findStmt.bind([pageId]);
            if (findStmt.step()) {
                leafTitleId = findStmt.get()[0] as number;
            }
        } finally {
            findStmt.free();
        }
        if (leafTitleId === null) return [];

        const chain: TocEntry[] = [];
        let cursor: number | null = leafTitleId;
        const lookup = db.prepare("SELECT id, page, parent FROM title WHERE id = ?");
        try {
            while (cursor !== null && cursor !== 0) {
                lookup.bind([cursor]);
                if (!lookup.step()) {
                    lookup.reset();
                    break;
                }
                const r = lookup.get();
                lookup.reset();
                const id = r[0] as number;
                const pg = r[1] as number;
                const parent = r[2] as number;
                chain.push({
                    title_id: id,
                    page_id: pg,
                    parent_id: parent,
                    has_children: false, // doesn't matter for chain
                });
                cursor = parent;
            }
        } finally {
            lookup.free();
        }
        chain.reverse(); // root → leaf
        return chain;
    }

    /**
     * Compute the page range for a section (a title and all its descendants).
     * The section starts at the title's page; the end is one less than the
     * next sibling's page id (or the last page in the book if no next sibling).
     */
    async getSection(bookId: number, titleId: number): Promise<SectionPageRange | null> {
        const db = await this.getDb(bookId);
        if (!db) return null;

        // Get this title's row.
        const meStmt = db.prepare("SELECT id, page, parent FROM title WHERE id = ?");
        let me: { id: number; page: number; parent: number } | null = null;
        try {
            meStmt.bind([titleId]);
            if (meStmt.step()) {
                const r = meStmt.get();
                me = { id: r[0] as number, page: r[1] as number, parent: r[2] as number };
            }
        } finally {
            meStmt.free();
        }
        if (!me) return null;

        // Find the next sibling (same parent, larger id).
        const sibStmt = db.prepare(
            "SELECT page FROM title WHERE parent = ? AND id > ? ORDER BY id ASC LIMIT 1",
        );
        let nextSiblingPage: number | null = null;
        try {
            sibStmt.bind([me.parent, titleId]);
            if (sibStmt.step()) nextSiblingPage = sibStmt.get()[0] as number;
        } finally {
            sibStmt.free();
        }

        let endPageId: number;
        if (nextSiblingPage !== null) {
            endPageId = nextSiblingPage - 1;
        } else {
            // No next sibling → walk up parents looking for ancestor next siblings.
            // Simpler approach: end = max page id in book.
            endPageId = await this.pageCount(bookId);
        }
        const startPageId = me.page;
        if (endPageId < startPageId) endPageId = startPageId;
        return {
            title_id: me.id,
            parent_id: me.parent,
            start_page_id: startPageId,
            end_page_id: endPageId,
            total_pages: endPageId - startPageId + 1,
        };
    }

    /** Distinct part values + counts for a multi-volume book. */
    async getBookParts(bookId: number): Promise<BookPart[]> {
        const db = await this.getDb(bookId);
        if (!db) return [];
        const stmt = db.prepare(
            "SELECT part, COUNT(*) AS cnt, MIN(id) AS first_id, MAX(id) AS last_id FROM page WHERE part IS NOT NULL AND part != '' GROUP BY part ORDER BY first_id",
        );
        try {
            const out: BookPart[] = [];
            while (stmt.step()) {
                const r = stmt.get();
                out.push({
                    part: r[0] as string,
                    page_count: r[1] as number,
                    first_page_id: r[2] as number,
                    last_page_id: r[3] as number,
                });
            }
            return out;
        } finally {
            stmt.free();
        }
    }

    /** Parse the per-page services JSON. Returns null when no services. */
    async getPageServices(bookId: number, pageId: number): Promise<PageServices | null> {
        const row = await this.getPageRow(bookId, pageId);
        if (!row || !row.services_raw) return null;
        try {
            const parsed = JSON.parse(row.services_raw) as Partial<PageServices>;
            const result: PageServices = { raw: parsed };
            if (Array.isArray(parsed.ayat)) result.ayat = parsed.ayat as number[];
            if (Array.isArray(parsed.hadeeth)) result.hadeeth = parsed.hadeeth as number[];
            if (Array.isArray(parsed.esnad)) result.esnad = parsed.esnad as string[];
            return result;
        } catch {
            return { raw: row.services_raw };
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

function rowToPage(r: ReturnType<ReturnType<Database["prepare"]>["get"]>): PageRow {
    const id = r[0] as number;
    const part = typeof r[1] === "string" && r[1].trim() ? r[1].trim() : null;
    const page = typeof r[2] === "number" ? r[2] : null;
    const number = typeof r[3] === "number" ? r[3] : null;
    const services = typeof r[4] === "string" && r[4].trim() ? r[4] : null;
    return {
        page_id: id,
        part: part === BOOK_LITERAL ? null : part,
        page,
        number,
        services_raw: services,
    };
}

function collectToc(db: Database, parentId: number, depth: number): TocEntry[] {
    const stmt = db.prepare("SELECT id, page, parent FROM title WHERE parent = ? ORDER BY id");
    const direct: TocEntry[] = [];
    try {
        stmt.bind([parentId]);
        while (stmt.step()) {
            const r = stmt.get();
            const id = r[0] as number;
            direct.push({
                title_id: id,
                page_id: r[1] as number,
                parent_id: r[2] as number,
                has_children: false, // populated below
            });
        }
    } finally {
        stmt.free();
    }
    // Populate has_children + recurse.
    if (!direct.length) return direct;
    const ids = direct.map((t) => t.title_id);
    const placeholders = ids.map(() => "?").join(",");
    const childCheck = db.prepare(
        `SELECT parent, COUNT(*) FROM title WHERE parent IN (${placeholders}) GROUP BY parent`,
    );
    try {
        childCheck.bind(ids);
        const childMap = new Map<number, number>();
        while (childCheck.step()) {
            const r = childCheck.get();
            childMap.set(r[0] as number, r[1] as number);
        }
        for (const t of direct) {
            t.has_children = (childMap.get(t.title_id) ?? 0) > 0;
        }
    } finally {
        childCheck.free();
    }
    if (depth > 1) {
        for (const t of direct) {
            if (t.has_children) t.children = collectToc(db, t.title_id, depth - 1);
        }
    }
    return direct;
}

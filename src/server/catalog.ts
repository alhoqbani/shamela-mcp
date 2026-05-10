/**
 * In-memory catalog loaded once from master.db. Per `docs/architecture.md`
 * §"SQLite cache strategy" and `docs/scope-implementation.md`.
 *
 * Maps:
 *   bookById       — book_id → BookRecord (full master.db.book row + parsed meta_data)
 *   authorById     — author_id → AuthorRecord
 *   categoryById   — category_id → CategoryRecord
 *   booksByAuthor  — author_id → [book_id]  (author_book ∪ coauthor_book)
 *   booksByCategory — category_id → [book_id]  (flat; no transitive)
 *   downloadedBookIds — Set<book_id> where major_ondisk > 0
 */

import * as fs from "node:fs";
import initSqlJs, { type Database } from "sql.js";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view.buffer as ArrayBuffer;
    }
    return view.slice().buffer as ArrayBuffer;
}

// --- Records ----------------------------------------------------------------

export interface BookRecord {
    book_id: number;
    book_name: string;
    book_category: number | null;
    book_type: number;
    book_date: number | null;
    authors_csv: string | null;
    main_author: number | null;
    printed: number;
    group_id: number | null;
    hidden: number;
    major_online: number;
    minor_online: number;
    major_ondisk: number;
    minor_ondisk: number;
    pdf_links: string | null;
    meta_data: BookMeta | null;
    parent: number | null;
}

export interface BookMeta {
    date?: string; // DDMMYYYY Hijri
    group?: number;
    coauthor?: number[];
    prefix?: string;
    suffix?: string;
    sub_books?: number[];
    shorts?: Record<string, string>;
    hide_diacritic?: boolean;
    min_ver?: number;
}

export interface AuthorRecord {
    author_id: number;
    author_name: string;
    death_year: number | null; // null if death_number == 0
    death_text: string | null;
}

export interface CategoryRecord {
    category_id: number;
    category_name: string;
    category_order: number;
}

// --- Scope diagnostics ------------------------------------------------------

export interface ScopeInputData {
    book_ids?: number[];
    author_ids?: number[];
    category_ids?: number[];
    period_from?: number;
    period_to?: number;
    downloaded_only?: boolean;
}

export interface ScopeResolution {
    book_ids: number[];
    diagnostics: Array<{ source: string; contributed: number }>;
}

// --- Catalog ----------------------------------------------------------------

export class Catalog {
    private readonly books = new Map<number, BookRecord>();
    private readonly authors = new Map<number, AuthorRecord>();
    private readonly categories = new Map<number, CategoryRecord>();
    private readonly _booksByAuthor = new Map<number, Set<number>>();
    private readonly _booksByCategory = new Map<number, Set<number>>();
    private readonly _downloadedBookIds = new Set<number>();

    private constructor() {}

    static async load(masterDbPath: string, wasmBinary: Uint8Array): Promise<Catalog> {
        if (!fs.existsSync(masterDbPath)) {
            throw new Error(`master.db not found at ${masterDbPath}`);
        }
        const buffer = fs.readFileSync(masterDbPath);
        const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(wasmBinary) });
        const db: Database = new SQL.Database(new Uint8Array(buffer));
        try {
            const cat = new Catalog();
            cat.loadCategories(db);
            cat.loadAuthors(db);
            cat.loadBooks(db);
            cat.buildAuthorJoins(db);
            return cat;
        } finally {
            db.close();
        }
    }

    private loadCategories(db: Database): void {
        const stmt = db.prepare("SELECT category_id, category_name, category_order FROM category");
        try {
            while (stmt.step()) {
                const r = stmt.get();
                const id = r[0] as number;
                this.categories.set(id, {
                    category_id: id,
                    category_name: (r[1] as string) ?? "",
                    category_order: (r[2] as number) ?? 0,
                });
            }
        } finally {
            stmt.free();
        }
    }

    private loadAuthors(db: Database): void {
        const stmt = db.prepare(
            "SELECT author_id, author_name, death_number, death_text FROM author",
        );
        try {
            while (stmt.step()) {
                const r = stmt.get();
                const id = r[0] as number;
                const death = r[2];
                const deathYear =
                    typeof death === "number" && death > 0 && death !== 99999 ? death : null;
                this.authors.set(id, {
                    author_id: id,
                    author_name: (r[1] as string) ?? "",
                    death_year: deathYear,
                    death_text: (r[3] as string) ?? null,
                });
            }
        } finally {
            stmt.free();
        }
    }

    private loadBooks(db: Database): void {
        const stmt = db.prepare(
            `SELECT book_id, book_name, book_category, book_type, book_date, authors,
                    main_author, printed, group_id, hidden, major_online, minor_online,
                    major_ondisk, minor_ondisk, pdf_links, meta_data, parent
             FROM book`,
        );
        try {
            while (stmt.step()) {
                const r = stmt.get();
                const bookId = r[0] as number;
                const meta = parseMeta(r[15] as string | null);
                const rec: BookRecord = {
                    book_id: bookId,
                    book_name: (r[1] as string) ?? "",
                    book_category: typeof r[2] === "number" ? r[2] : null,
                    book_type: (r[3] as number) ?? 1,
                    book_date: typeof r[4] === "number" && r[4] > 0 ? r[4] : null,
                    authors_csv: (r[5] as string) ?? null,
                    main_author: typeof r[6] === "number" ? r[6] : null,
                    printed: (r[7] as number) ?? 0,
                    group_id: typeof r[8] === "number" ? r[8] : null,
                    hidden: (r[9] as number) ?? 0,
                    major_online: (r[10] as number) ?? 0,
                    minor_online: (r[11] as number) ?? 0,
                    major_ondisk: (r[12] as number) ?? 0,
                    minor_ondisk: (r[13] as number) ?? 0,
                    pdf_links: (r[14] as string) ?? null,
                    meta_data: meta,
                    parent: typeof r[16] === "number" ? r[16] : null,
                };
                this.books.set(bookId, rec);
                if (rec.major_ondisk > 0) this._downloadedBookIds.add(bookId);
                if (rec.book_category !== null) {
                    let bucket = this._booksByCategory.get(rec.book_category);
                    if (!bucket) {
                        bucket = new Set();
                        this._booksByCategory.set(rec.book_category, bucket);
                    }
                    bucket.add(bookId);
                }
            }
        } finally {
            stmt.free();
        }
    }

    private buildAuthorJoins(db: Database): void {
        for (const table of ["author_book", "coauthor_book"]) {
            const stmt = db.prepare(`SELECT author_id, book_id FROM ${table}`);
            try {
                while (stmt.step()) {
                    const r = stmt.get();
                    const a = r[0] as number;
                    const b = r[1] as number;
                    let bucket = this._booksByAuthor.get(a);
                    if (!bucket) {
                        bucket = new Set();
                        this._booksByAuthor.set(a, bucket);
                    }
                    bucket.add(b);
                }
            } finally {
                stmt.free();
            }
        }
    }

    // --- Public lookups -----------------------------------------------------

    bookRecord(bookId: number): BookRecord | undefined {
        return this.books.get(bookId);
    }

    authorRecord(authorId: number): AuthorRecord | undefined {
        return this.authors.get(authorId);
    }

    category(categoryId: number): CategoryRecord | undefined {
        return this.categories.get(categoryId);
    }

    listCategories(): CategoryRecord[] {
        const arr = Array.from(this.categories.values());
        arr.sort((a, b) => a.category_order - b.category_order);
        return arr;
    }

    booksInCategory(categoryId: number): number[] {
        const set = this._booksByCategory.get(categoryId);
        return set ? Array.from(set) : [];
    }

    booksByAuthorId(authorId: number): number[] {
        const set = this._booksByAuthor.get(authorId);
        return set ? Array.from(set) : [];
    }

    /** All books authored or co-authored by any of the given author IDs. */
    booksByAuthors(authorIds: number[]): Set<number> {
        const out = new Set<number>();
        for (const a of authorIds) {
            const set = this._booksByAuthor.get(a);
            if (set) for (const b of set) out.add(b);
        }
        return out;
    }

    downloadedBookIds(): Set<number> {
        return new Set(this._downloadedBookIds);
    }

    isDownloaded(bookId: number): boolean {
        return this._downloadedBookIds.has(bookId);
    }

    /** Display name of the book's main author, joining the catalog. */
    mainAuthorName(book: BookRecord): string | null {
        if (book.main_author === null) return null;
        const a = this.authors.get(book.main_author);
        return a?.author_name ?? null;
    }

    /** All authors of the book (main + co-authors) by id, in insertion order. */
    bookAuthors(book: BookRecord): AuthorRecord[] {
        const ids: number[] = [];
        if (book.main_author !== null) ids.push(book.main_author);
        if (book.authors_csv) {
            for (const part of book.authors_csv.split(",")) {
                const id = parseInt(part.trim(), 10);
                if (!Number.isNaN(id) && !ids.includes(id)) ids.push(id);
            }
        }
        if (book.meta_data?.coauthor) {
            for (const id of book.meta_data.coauthor) if (!ids.includes(id)) ids.push(id);
        }
        const out: AuthorRecord[] = [];
        for (const id of ids) {
            const a = this.authors.get(id);
            if (a) out.push(a);
        }
        return out;
    }

    /** Path of category names from root → leaf. Categories are flat in master.db, so length is always 1. */
    categoryPath(categoryId: number | null): string[] {
        if (categoryId === null) return [];
        const c = this.categories.get(categoryId);
        return c ? [c.category_name] : [];
    }

    bookCount(): number {
        return this.books.size;
    }

    authorCount(): number {
        return this.authors.size;
    }

    categoryCount(): number {
        return this.categories.size;
    }

    /** Iterate all books — for filters that need to scan the whole catalog. */
    allBooks(): IterableIterator<BookRecord> {
        return this.books.values();
    }
}

function parseMeta(raw: string | null): BookMeta | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as BookMeta;
    } catch {
        return null;
    }
}

// ----------------------------------------------------------------------------
// CatalogScope — resolves ScopeInput → book_ids[] per docs/scope-implementation.md
// ----------------------------------------------------------------------------

export class CatalogScope {
    constructor(private readonly catalog: Catalog) {}

    /**
     * Resolve a scope input to a sorted unique array of book_ids. If no scope
     * fields are provided, returns ALL books. Throws ShamelaError on EMPTY_SCOPE
     * (caller decides whether to upgrade or treat as zero hits).
     */
    resolveBookIds(scope: ScopeInputData | undefined): ScopeResolution {
        const diagnostics: Array<{ source: string; contributed: number }> = [];
        const allBooks = (): Set<number> => {
            const s = new Set<number>();
            for (const b of this.catalog.allBooks()) s.add(b.book_id);
            return s;
        };

        let result: Set<number> | null = null;
        const intersect = (other: Set<number>) => {
            if (result === null) {
                result = other;
            } else {
                const next = new Set<number>();
                for (const id of result) if (other.has(id)) next.add(id);
                result = next;
            }
        };

        if (scope) {
            if (scope.book_ids?.length) {
                const set = new Set(scope.book_ids);
                diagnostics.push({ source: "book_ids", contributed: set.size });
                intersect(set);
            }
            if (scope.author_ids?.length) {
                const set = this.catalog.booksByAuthors(scope.author_ids);
                diagnostics.push({ source: "author_ids", contributed: set.size });
                intersect(set);
            }
            if (scope.category_ids?.length) {
                const set = new Set<number>();
                for (const cid of scope.category_ids) {
                    for (const b of this.catalog.booksInCategory(cid)) set.add(b);
                }
                diagnostics.push({ source: "category_ids", contributed: set.size });
                intersect(set);
            }
            if (scope.period_from !== undefined || scope.period_to !== undefined) {
                const from = scope.period_from ?? 1;
                const to = scope.period_to ?? 9999;
                const set = new Set<number>();
                for (const b of this.catalog.allBooks()) {
                    if (b.book_date !== null && b.book_date >= from && b.book_date <= to) {
                        set.add(b.book_id);
                    }
                }
                // Union with books authored by anyone whose death year is in range.
                const authorIds: number[] = [];
                for (const a of this.catalog["authors"].values() as IterableIterator<AuthorRecord>) {
                    if (a.death_year !== null && a.death_year >= from && a.death_year <= to) {
                        authorIds.push(a.author_id);
                    }
                }
                for (const b of this.catalog.booksByAuthors(authorIds)) set.add(b);
                diagnostics.push({ source: `period[${from}..${to}]`, contributed: set.size });
                intersect(set);
            }
            if (scope.downloaded_only) {
                const set = this.catalog.downloadedBookIds();
                diagnostics.push({ source: "downloaded_only", contributed: set.size });
                intersect(set);
            }
        }

        if (result === null) {
            // No scope at all — caller searches all books.
            const arr = Array.from(allBooks()).sort((a, b) => a - b);
            return { book_ids: arr, diagnostics };
        }

        const arr = Array.from(result as Set<number>).sort((a, b) => a - b);
        diagnostics.push({ source: "intersection", contributed: arr.length });
        return { book_ids: arr, diagnostics };
    }
}

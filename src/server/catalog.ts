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
 *   downloadedBookIds — Set<book_id> whose per-book file exists on disk (∩ catalog);
 *                       master.db's major_ondisk is kept separately as an index hint,
 *                       since a copied or restored library has files but no flags
 */

import { UNDATED_BOOK_DATE } from "./constants.js";
import type { ShamelaDb, SqlDatabase } from "./db.js";
import { DiskIndex } from "./diskIndex.js";

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
    /**
     * Shamela's stamp for this catalogue entry: eight digits, ddMMyyyy Hijri
     * (verified against all 8,593 shipped rows). NOT the book's publication
     * date — every value falls in 1431–1447 AH, and 56% of them are the single
     * value 08121431, the day the v4 library was seeded. It records when the
     * entry was added or refreshed.
     */
    date?: string;
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
    period_basis?: "composed" | "died" | "either";
    madhhab?: Array<"hanafi" | "maliki" | "shafii" | "hanbali">;
    downloaded_only?: boolean;
}

export interface ScopeResolution {
    book_ids: number[];
    diagnostics: Array<{ source: string; contributed: number }>;
}

/**
 * Shamela files each school's fiqh under its own flat category. These are the
 * ids on the shipped catalogue; the general-fiqh, fatwa and usul categories are
 * deliberately NOT in this map — a comparison should not silently absorb them.
 */
export const MADHHAB_CATEGORY: Record<"hanafi" | "maliki" | "shafii" | "hanbali", number> = {
    hanafi: 14,
    maliki: 15,
    shafii: 16,
    hanbali: 17,
};

// --- Catalog ----------------------------------------------------------------

export class Catalog {
    private readonly books = new Map<number, BookRecord>();
    private readonly authors = new Map<number, AuthorRecord>();
    private readonly categories = new Map<number, CategoryRecord>();
    private readonly _booksByAuthor = new Map<number, Set<number>>();
    private readonly _booksByCategory = new Map<number, Set<number>>();
    /** Books whose per-book file exists on disk AND that the catalog knows. */
    private _downloadedBookIds = new Set<number>();
    /** Books master.db flags as downloaded — an index hint, not the authority. */
    private readonly _flaggedBookIds = new Set<number>();
    /** Files on disk with no catalog row; reported, never listed as books. */
    private readonly _orphanFileIds = new Set<number>();
    /** Books that appeared after the first scan — Lucene has not indexed them. */
    private readonly _sessionDiscovered = new Set<number>();
    private _diskScanFellBack = false;
    private diskIndex: DiskIndex | null = null;
    /** book_id → author_ids from coauthor_book, which authors_csv omits. */
    private readonly _coauthorsByBook = new Map<number, number[]>();
    /** authors_csv tokens that were not a plain id; surfaced in health. */
    private _authorsCsvAnomalies = 0;

    private constructor() {}

    static async load(
        masterDbPath: string,
        db: ShamelaDb,
        opts: { databaseRoot: string; diskIndex?: DiskIndex },
    ): Promise<Catalog> {
        const handle = await db.open(masterDbPath);
        if (!handle) {
            throw new Error(`master.db not found at ${masterDbPath}`);
        }
        try {
            const cat = new Catalog();
            cat.loadCategories(handle);
            cat.loadAuthors(handle);
            cat.loadBooks(handle);
            cat.buildAuthorJoins(handle);
            const idx = opts.diskIndex ?? new DiskIndex(opts.databaseRoot);
            if (!idx.scanned) idx.scan();
            cat.applyDiskIndex(idx);
            return cat;
        } finally {
            handle.close();
        }
    }

    /**
     * Decide what counts as downloaded: files on disk, intersected with the
     * catalog so a stray file never surfaces as a nameless book.
     */
    private applyDiskIndex(idx: DiskIndex): void {
        this.diskIndex = idx;
        for (const id of idx.ids) {
            if (this.books.has(id)) this._downloadedBookIds.add(id);
            else this._orphanFileIds.add(id);
        }
        // If the book folder could not be listed at all — wrong path,
        // permissions, a disconnected drive — fall back to the catalog flags.
        // An empty but readable folder is a genuinely empty library and gets no
        // fallback; only an unreadable one does, because announcing that the
        // user's library vanished is worse than a stale flag.
        if (!idx.rootReadable && this._flaggedBookIds.size > 0) {
            this._downloadedBookIds = new Set(this._flaggedBookIds);
            this._diskScanFellBack = true;
        }
    }

    private loadCategories(db: SqlDatabase): void {
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

    private loadAuthors(db: SqlDatabase): void {
        const stmt = db.prepare(
            "SELECT author_id, author_name, death_number, death_text FROM author",
        );
        try {
            while (stmt.step()) {
                const r = stmt.get();
                const id = r[0] as number;
                const death = r[2];
                const deathYear =
                    typeof death === "number" && death > 0 && death !== UNDATED_BOOK_DATE
                        ? death
                        : null;
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

    private loadBooks(db: SqlDatabase): void {
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
                    // 99999 is Shamela's "no date" sentinel, exactly as it is
                    // for an author's death year above. It used to survive into
                    // BookRecord, so three call sites filtered it and three did
                    // not — and a citation printed «٩٩٩٩٩هـ» as a Hijri year.
                    // Normalised here, once, so no consumer has to know.
                    book_date:
                        typeof r[4] === "number" && r[4] > 0 && r[4] !== UNDATED_BOOK_DATE
                            ? r[4]
                            : null,
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
                if (rec.major_ondisk > 0) this._flaggedBookIds.add(bookId);
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

    private buildAuthorJoins(db: SqlDatabase): void {
        for (const table of ["author_book", "coauthor_book"]) {
            const stmt = db.prepare(`SELECT author_id, book_id FROM ${table}`);
            try {
                while (stmt.step()) {
                    const r = stmt.get();
                    const a = r[0] as number;
                    const b = r[1] as number;
                    if (table === "coauthor_book") {
                        const list = this._coauthorsByBook.get(b);
                        if (list) {
                            if (!list.includes(a)) list.push(a);
                        } else {
                            this._coauthorsByBook.set(b, [a]);
                        }
                    }
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

    /** master.db's own flag. Kept for reporting; it is not what gates reading. */
    isFlaggedOnDisk(bookId: number): boolean {
        return this._flaggedBookIds.has(bookId);
    }

    flaggedBookCount(): number {
        return this._flaggedBookIds.size;
    }

    /**
     * Check one book's file directly and remember the answer. Costs a stat, so
     * callers use it only after isDownloaded() said no — which is how a book
     * that appeared since the scan (copied in, or just downloaded) starts
     * working without restarting the server.
     */
    confirmOnDisk(bookId: number): boolean {
        if (this._downloadedBookIds.has(bookId)) return true;
        if (!this.books.has(bookId)) return false;
        if (!this.diskIndex?.confirm(bookId)) return false;
        this._downloadedBookIds.add(bookId);
        this._sessionDiscovered.add(bookId);
        return true;
    }

    /** Flagged as downloaded but with no file — an interrupted download or a moved folder. */
    flaggedFileMissingIds(): number[] {
        const out: number[] = [];
        for (const id of this._flaggedBookIds) {
            if (!this._downloadedBookIds.has(id)) out.push(id);
        }
        return out;
    }

    /** Book files with no catalog row. Diagnostic only; never listed as books. */
    orphanFileIds(): number[] {
        return Array.from(this._orphanFileIds);
    }

    /** True when the disk scan failed and the catalog flags were used instead. */
    diskScanFellBack(): boolean {
        return this._diskScanFellBack;
    }

    authorsCsvAnomalyCount(): number {
        return this._authorsCsvAnomalies;
    }

    /**
     * Books that showed up after the first scan. The Java helper opens Shamela's
     * Lucene indexes once at startup, so their text is not searchable or
     * readable until it reopens them — which is why these are tracked at all.
     */
    markSessionDiscovered(ids: Iterable<number>): void {
        for (const id of ids) if (this.books.has(id)) this._sessionDiscovered.add(id);
    }

    isSessionDiscovered(bookId: number): boolean {
        return this._sessionDiscovered.has(bookId);
    }

    sessionDiscoveredIds(): number[] {
        return Array.from(this._sessionDiscovered);
    }

    /** Called once the helper has reopened its index readers. */
    clearSessionDiscovered(): void {
        this._sessionDiscovered.clear();
    }

    /** Carry forward books discovered mid-session across a catalog reload. */
    adoptSessionDiscovered(previous: Catalog): void {
        for (const id of previous._sessionDiscovered) {
            if (this.books.has(id)) this._sessionDiscovered.add(id);
        }
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
                const token = part.trim();
                // parseInt is too forgiving here: "12abc" would become author 12
                // and "3.7" author 3, attributing the book to the wrong person
                // without a word. Require the whole token to be a plain id.
                if (!/^\d{1,9}$/.test(token)) {
                    if (token) this._authorsCsvAnomalies++;
                    continue;
                }
                const id = Number(token);
                if (id !== 0 && !ids.includes(id)) ids.push(id);
            }
        }
        if (book.meta_data?.coauthor) {
            for (const id of book.meta_data.coauthor) if (!ids.includes(id)) ids.push(id);
        }
        // coauthor_book already feeds booksByAuthor, so scoping a search by an
        // author returns books this list did not credit them for. One real pair
        // in the shipped catalog was affected.
        for (const id of this._coauthorsByBook.get(book.book_id) ?? []) {
            if (!ids.includes(id)) ids.push(id);
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

    /** Iterate all authors — for indexes built over the whole catalog. */
    allAuthors(): IterableIterator<AuthorRecord> {
        return this.authors.values();
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
            if (scope.madhhab && scope.madhhab.length) {
                const set = new Set<number>();
                for (const school of scope.madhhab) {
                    for (const b of this.catalog.booksInCategory(MADHHAB_CATEGORY[school])) set.add(b);
                }
                diagnostics.push({ source: `madhhab[${scope.madhhab.join(",")}]`, contributed: set.size });
                intersect(set);
            }
            if (scope.period_from !== undefined || scope.period_to !== undefined) {
                const from = scope.period_from ?? 1;
                const to = scope.period_to ?? 9999;
                // A book's composition year and its author's death year are
                // different facts, and answering "what was written in this
                // century" with the union of both quietly includes books
                // composed outside it. Default stays the union for
                // compatibility; callers who care can say which they mean.
                const basis = scope.period_basis ?? "either";
                const set = new Set<number>();
                if (basis !== "died") {
                    for (const b of this.catalog.allBooks()) {
                        if (b.book_date !== null && b.book_date >= from && b.book_date <= to) {
                            set.add(b.book_id);
                        }
                    }
                }
                if (basis !== "composed") {
                    const authorIds: number[] = [];
                    for (const a of this.catalog["authors"].values() as IterableIterator<AuthorRecord>) {
                        if (a.death_year !== null && a.death_year >= from && a.death_year <= to) {
                            authorIds.push(a.author_id);
                        }
                    }
                    for (const b of this.catalog.booksByAuthors(authorIds)) set.add(b);
                }
                diagnostics.push({ source: `period[${from}..${to}] by ${basis}`, contributed: set.size });
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

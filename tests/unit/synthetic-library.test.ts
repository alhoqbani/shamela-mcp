/**
 * Issue #27 — the catalogue paths, tested without a Shamela install.
 *
 * The issue asked for a fixture library and framed it as a licensing problem:
 * find freely-licensed books to test against. That framing is wrong, and the
 * reason is worth stating because it is what kept the item open. Search does
 * not run on our engine; it runs on Lucene read out of the user's own Shamela
 * folder, so no set of books, however licensed, makes a search test runnable on
 * a build machine. But everything that is not search reads SQLite — and SQLite
 * files of the right shape can simply be made.
 *
 * So this runs under `npm run test:unit`, which is what CI executes, on a
 * machine with no Shamela install and nothing to license.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import initSqlJs from "sql.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { Catalog, CatalogScope } from "../../src/server/catalog.js";
import { PageStore } from "../../src/server/pages.js";
import {
    EXPECTED_SCHEMA,
    SYN,
    SYN_AUTHOR,
    SYN_CATEGORY,
    SYNTH_MARK,
    createSyntheticLibrary,
    type SyntheticLibrary,
} from "../fixtures/synthetic-library.js";
import { getDb, getSqlWasm } from "../fixtures/shared.js";

let lib: SyntheticLibrary;
let catalog: Catalog;
let pages: PageStore;

/** The CREATE TABLE text of one file, whitespace-collapsed and sorted. */
async function tablesOf(file: string): Promise<string[]> {
    const SQL = await initSqlJs({ wasmBinary: getSqlWasm().buffer as ArrayBuffer });
    const db = new SQL.Database(fs.readFileSync(file));
    const res = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name");
    const out = (res[0]?.values ?? []).map((r) => String(r[0]).replace(/\s+/g, " ").trim());
    db.close();
    return out;
}

beforeAll(async () => {
    lib = await createSyntheticLibrary();
    catalog = await Catalog.load(path.join(lib.database, "master.db"), getDb(), {
        databaseRoot: lib.database,
    });
    pages = new PageStore(lib.database, getDb());
}, 60_000);

afterAll(() => lib?.cleanup());

describe("the fixture has the shape of a real library", () => {
    // Half the guard. The other half reads the same constant out of a real
    // install, so a schema change in Shamela fails on a maintainer's machine
    // before this fixture can start lying to CI.
    it("master.db carries exactly the real tables", async () => {
        expect(await tablesOf(path.join(lib.database, "master.db"))).toEqual([...EXPECTED_SCHEMA.master]);
    });

    it("a per-book file carries exactly the real tables", async () => {
        const file = path.join(lib.database, "book", "009", `${SYN.PADDED}.db`);
        expect(await tablesOf(file)).toEqual([...EXPECTED_SCHEMA.book]);
    });

    it("a service file carries exactly the real tables", async () => {
        expect(await tablesOf(path.join(lib.database, "service", "tafseer.db"))).toEqual([
            ...EXPECTED_SCHEMA.service,
        ]);
    });
});

describe("nothing in the fixture reads as a real book", () => {
    // The rule this enforces: a fixture for a library of religious source
    // material must contain nothing quotable. Every name is marked, and the
    // page tables hold numbers only — there is no column for prose to hide in.
    it("every book, author and category name is marked synthetic", () => {
        for (const id of Object.values(SYN)) {
            const rec = catalog.bookRecord(id);
            if (rec) expect(rec.book_name, `book ${id}`).toContain(SYNTH_MARK);
        }
        for (const id of Object.values(SYN_AUTHOR)) {
            expect(catalog.authorRecord(id)?.author_name, `author ${id}`).toContain(SYNTH_MARK);
        }
        for (const c of catalog.listCategories()) {
            expect(c.category_name, `category ${c.category_id}`).toContain(SYNTH_MARK);
        }
    });

    it("the page table has no column that could hold text", () => {
        // Page bodies live in Lucene, not here. If this ever gains a text
        // column, the fixture stops being safe and the claim above stops
        // being true.
        expect(EXPECTED_SCHEMA.book[0]).not.toContain("body");
        expect(EXPECTED_SCHEMA.book[0]).not.toContain("text");
    });
});

describe("the catalogue reads it", () => {
    it("knows the books, authors and categories it was given", () => {
        expect(catalog.bookCount()).toBe(9);
        expect(catalog.authorCount()).toBe(3);
        expect(catalog.categoryCount()).toBe(4);
    });

    it("lets the disk decide what is downloaded, not the flag", () => {
        // SYN.MISSING is flagged downloaded in master.db and has no file.
        // That divergence is issue #43, and it is the whole reason the file
        // is the authority here.
        const downloaded = catalog.downloadedBookIds();
        expect(downloaded.has(SYN.PADDED)).toBe(true);
        expect(downloaded.has(SYN.MISSING)).toBe(false);
        expect(catalog.flaggedFileMissingIds()).toContain(SYN.MISSING);
    });

    it("sees a file with no catalogue row as an orphan", () => {
        expect(catalog.orphanFileIds()).toContain(SYN.ORPHAN);
        expect(catalog.bookRecord(SYN.ORPHAN)).toBeUndefined();
    });

    it("reads Shamela's no-death-year sentinel as no year", () => {
        // 99999 is a placeholder, not a date. Rendering it would print a
        // year nine hundred centuries hence.
        expect(catalog.authorRecord(SYN_AUTHOR.DATED)?.death_year).toBe(700);
        expect(catalog.authorRecord(SYN_AUTHOR.UNDATED)?.death_year).toBeNull();
    });

    it("reads the same sentinel in a book's date as no date", () => {
        // The author side was normalised from the start; the book side was
        // not, so three call sites filtered 99999 and three printed it. A
        // real citation read «عادل مصطفى. المغالطات المنطقية. ٩٩٩٩٩هـ.»
        // Normalising in the loader is what makes every consumer safe.
        expect(catalog.bookRecord(SYN.BUCKET_000)?.book_date).toBe(300);
        expect(catalog.bookRecord(SYN.UNDATED)?.book_date).toBeNull();
    });

    it("finds a co-author the authors column never mentions", () => {
        expect(catalog.booksByAuthorId(SYN_AUTHOR.COAUTHOR)).toContain(SYN.PADDED);
    });
});

describe("scope resolution against real SQLite", () => {
    const scope = () => new CatalogScope(catalog);

    it("an empty scope is every book", () => {
        expect(scope().resolveBookIds({ downloaded_only: false }).book_ids.length).toBe(9);
    });

    it("a school filter takes that school's category and not the general one", () => {
        const ids = scope().resolveBookIds({ madhhab: ["shafii"], downloaded_only: false }).book_ids;
        expect(ids).toContain(SYN.PADDED);
        expect(ids).toContain(SYN.MULTI);
        expect(ids).not.toContain(SYN.BUCKET_000);
    });

    it("downloaded_only drops the book whose file is missing", () => {
        const ids = scope().resolveBookIds({ downloaded_only: true }).book_ids;
        expect(ids).not.toContain(SYN.MISSING);
    });

    it("a category with no books resolves to nothing rather than everything", () => {
        const ids = scope().resolveBookIds({ category_ids: [4242], downloaded_only: false }).book_ids;
        expect(ids).toEqual([]);
    });
});

describe("page reading against real SQLite", () => {
    // Issue #47 in fixture form: the bucket folder is the remainder padded to
    // three digits, and every book whose remainder was under 100 used to be
    // unreadable. All four spellings are here.
    it("resolves a book in every bucket spelling", async () => {
        for (const id of [SYN.BUCKET_000, SYN.PADDED, SYN.BUCKET_099, SYN.PLAIN, SYN.MULTI]) {
            expect(await pages.bookHasContent(id), `book ${id}`).toBe(true);
        }
    });

    it("tells a present-but-empty book from a missing one", async () => {
        expect(await pages.bookHasContent(SYN.EMPTY)).toBe(false);
        expect(await pages.bookHasContent(SYN.MISSING)).toBe(false);
    });

    it("prints the printed page, which is not the page id", async () => {
        // Page id 85 carries printed page 6. Conflating the two is what put
        // «ص NaN» in citations once.
        const printed = await pages.printedPage(SYN.PADDED, 85);
        expect(printed).toBe("6");
    });

    it("prints a volume-bearing page as part and page together", async () => {
        expect(await pages.printedPage(SYN.MULTI, 20)).toBe("2/ 3");
    });

    it("returns null rather than throwing for a book it does not have", async () => {
        expect(await pages.printedPage(SYN.MISSING, 1)).toBeNull();
    });

    it("reads a table of contents", async () => {
        const toc = await pages.getToc(SYN.PADDED);
        expect(toc.length).toBeGreaterThan(0);
        expect(toc.map((t) => t.page_id)).toContain(80);
    });
});

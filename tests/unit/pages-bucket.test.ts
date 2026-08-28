/**
 * Regression test for the zero-padded bucket-folder bug.
 *
 * Shamela stores per-book SQLite files under `database/book/<id % 1000>/<id>.db`,
 * but current Shamela 4 builds zero-pad the bucket folder to three digits
 * (`book/009/9.db`) while the reader used to build the path unpadded
 * (`book/9/9.db`). The two spellings only differ for buckets < 100, so every
 * book with `id % 1000 < 100` was misreported as «منزَّل لكن بلا صفحات مقروءة»
 * while Lucene search (which reads Shamela's own index) kept returning its
 * text — an internal contradiction that poisoned "not found in the library"
 * conclusions. The canonical fixture book (9942 → bucket 942) could never
 * catch this, hence this dedicated test over a synthetic library exercising
 * all three layouts.
 *
 * Runs without a Shamela install: it fabricates minimal per-book DBs via
 * sql.js in a temp folder.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import initSqlJs from "sql.js";

import { PageStore } from "../../src/server/pages.js";
import { getDb, getSqlWasm } from "../fixtures/shared.js";

/** Books covering the three on-disk layouts. */
const PADDED_ID = 9; // bucket 9  → modern layout  book/009/9.db
const LEGACY_ID = 7; // bucket 7  → legacy layout  book/7/7.db
const HIGH_ID = 10_942; // bucket 942 → identical in both spellings
const MISSING_ID = 555; // downloaded nowhere
const BUCKET0_PADDED_ID = 5_000; // bucket 0   → modern layout  book/000/5000.db
const BUCKET0_LEGACY_ID = 6_000; // bucket 0   → legacy layout  book/0/6000.db
const BUCKET99_ID = 3_099; // bucket 99  → last bucket that still needs padding
const BUCKET100_ID = 12_100; // bucket 100 → first bucket that needs none
const BUCKET999_ID = 1_999; // bucket 999 → top of the range, single spelling
const MISSING_LOW_ID = 7_000; // bucket 0, absent under BOTH spellings

let tempRoot: string;
let pages: PageStore;

async function writeBookDb(dir: string, bookId: number, pageId: number, printed: number): Promise<void> {
    const SQL = await initSqlJs({
        wasmBinary: (() => {
            const buf = getSqlWasm();
            return (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
                ? buf.buffer
                : buf.slice().buffer) as ArrayBuffer;
        })(),
    });
    const db = new SQL.Database();
    db.run("CREATE TABLE page (id INTEGER PRIMARY KEY, part TEXT, page INTEGER, number INTEGER, services TEXT)");
    db.run("CREATE TABLE title (id INTEGER PRIMARY KEY, page INTEGER, parent INTEGER)");
    db.run("INSERT INTO page (id, part, page, number, services) VALUES (?, NULL, ?, NULL, NULL)", [
        pageId,
        printed,
    ]);
    db.run("INSERT INTO title (id, page, parent) VALUES (1, ?, 0)", [pageId]);
    const bytes = db.export();
    db.close();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${bookId}.db`), bytes);
}

beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shamela-bucket-test-"));
    // Modern zero-padded layout for a bucket < 100 (the bug's exact shape).
    await writeBookDb(path.join(tempRoot, "book", "009"), PADDED_ID, 63, 71);
    // Legacy unpadded layout must keep working too.
    await writeBookDb(path.join(tempRoot, "book", "7"), LEGACY_ID, 5, 12);
    // Bucket >= 100: both spellings coincide.
    await writeBookDb(path.join(tempRoot, "book", "942"), HIGH_ID, 3, 9);
    // Bucket 0 is the padStart(3) edge: "0" must become "000" — not "00", not "".
    await writeBookDb(path.join(tempRoot, "book", "000"), BUCKET0_PADDED_ID, 11, 1);
    await writeBookDb(path.join(tempRoot, "book", "0"), BUCKET0_LEGACY_ID, 12, 2);
    // 99 / 100 straddle the padding boundary in both directions.
    await writeBookDb(path.join(tempRoot, "book", "099"), BUCKET99_ID, 13, 3);
    await writeBookDb(path.join(tempRoot, "book", "100"), BUCKET100_ID, 14, 4);
    // 999: the highest bucket — still one spelling only.
    await writeBookDb(path.join(tempRoot, "book", "999"), BUCKET999_ID, 15, 5);
    pages = new PageStore(tempRoot, getDb());
});

afterAll(() => {
    // Best-effort cleanup: on Windows the wasm FS may keep a transient handle.
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe("PageStore bucket-folder resolution", () => {
    it("reads a book stored under a zero-padded bucket (book/009/9.db)", async () => {
        expect(await pages.hasBook(PADDED_ID)).toBe(true);
        const row = await pages.getPageRow(PADDED_ID, 63);
        expect(row).not.toBeNull();
        expect(row!.page_id).toBe(63);
        // pageCount is MAX(id)-based (real books have sequential page ids).
        expect(await pages.pageCount(PADDED_ID)).toBeGreaterThan(0);
        expect(await pages.bookHasContent(PADDED_ID)).toBe(true);
    });

    it("still reads a book stored under a legacy unpadded bucket (book/7/7.db)", async () => {
        expect(await pages.hasBook(LEGACY_ID)).toBe(true);
        const row = await pages.getPageRow(LEGACY_ID, 5);
        expect(row).not.toBeNull();
        expect(await pages.bookHasContent(LEGACY_ID)).toBe(true);
    });

    it("reads a bucket >= 100 where both spellings coincide (book/942/10942.db)", async () => {
        expect(await pages.hasBook(HIGH_ID)).toBe(true);
        expect(await pages.bookHasContent(HIGH_ID)).toBe(true);
    });

    it("reads bucket 0 under the padded spelling (book/000/5000.db)", async () => {
        // The padStart(3) edge: an unpadded "0" is a folder Shamela never writes.
        expect(await pages.hasBook(BUCKET0_PADDED_ID)).toBe(true);
        const row = await pages.getPageRow(BUCKET0_PADDED_ID, 11);
        expect(row).not.toBeNull();
        expect(row!.page_id).toBe(11);
        expect(await pages.bookHasContent(BUCKET0_PADDED_ID)).toBe(true);
    });

    it("still reads bucket 0 under the legacy spelling (book/0/6000.db)", async () => {
        expect(await pages.hasBook(BUCKET0_LEGACY_ID)).toBe(true);
        expect(await pages.bookHasContent(BUCKET0_LEGACY_ID)).toBe(true);
    });

    it("reads bucket 99 — the last bucket that needs padding (book/099/3099.db)", async () => {
        expect(await pages.hasBook(BUCKET99_ID)).toBe(true);
        const row = await pages.getPageRow(BUCKET99_ID, 13);
        expect(row).not.toBeNull();
        expect(row!.page_id).toBe(13);
        expect(await pages.bookHasContent(BUCKET99_ID)).toBe(true);
    });

    it("reads bucket 100 — the first bucket that needs none (book/100/12100.db)", async () => {
        expect(await pages.hasBook(BUCKET100_ID)).toBe(true);
        expect(await pages.bookHasContent(BUCKET100_ID)).toBe(true);
    });

    it("reads bucket 999 — the top of the range (book/999/1999.db)", async () => {
        expect(await pages.hasBook(BUCKET999_ID)).toBe(true);
        expect(await pages.bookHasContent(BUCKET999_ID)).toBe(true);
    });

    it("reports a low-bucket book absent under BOTH spellings as not downloaded", async () => {
        // The only path that walks the whole spelling list and falls through to null.
        expect(await pages.hasBook(MISSING_LOW_ID)).toBe(false);
        expect(await pages.bookHasContent(MISSING_LOW_ID)).toBe(false);
        expect(await pages.getPageRow(MISSING_LOW_ID, 1)).toBeNull();
    });

    it("still reports a truly missing book as not downloaded", async () => {
        expect(await pages.hasBook(MISSING_ID)).toBe(false);
        expect(await pages.bookHasContent(MISSING_ID)).toBe(false);
        expect(await pages.getPageRow(MISSING_ID, 1)).toBeNull();
    });
});

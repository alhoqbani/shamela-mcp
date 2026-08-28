/**
 * Picking up a library that changes mid-session.
 *
 * The catalog is read once at startup, which made the recommendation flow
 * pointless: the extension would tell a researcher which book to download and
 * then be unable to see it. These tests pin the behaviour that matters and,
 * more importantly, the ways it must NOT misbehave — a failed refresh must
 * never turn an unrelated request into an error, and it must never be so eager
 * that it stats the disk on every tool call.
 *
 * The clock is injected, so none of this sleeps.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Catalog } from "../../src/server/catalog.js";
import { CatalogFreshness } from "../../src/server/freshness.js";
import { getDb, getSqlWasm } from "../fixtures/shared.js";

let root: string;
let masterDb: string;
let clock: number;

/** Build a master.db with the given books, and their files on disk. */
async function writeLibrary(books: Array<{ id: number; name: string; flagged?: boolean }>): Promise<void> {
    const initSqlJs = (await import("sql.js")).default;
    const buf = getSqlWasm();
    const SQL = await initSqlJs({
        wasmBinary: (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
            ? buf.buffer
            : buf.slice().buffer) as ArrayBuffer,
    });
    const db = new SQL.Database();
    db.run(`CREATE TABLE category (category_id INTEGER, category_name TEXT, category_order INTEGER)`);
    db.run(`CREATE TABLE author (author_id INTEGER, author_name TEXT, death_number INTEGER, death_text TEXT)`);
    db.run(`CREATE TABLE author_book (author_id INTEGER, book_id INTEGER)`);
    db.run(`CREATE TABLE coauthor_book (author_id INTEGER, book_id INTEGER)`);
    db.run(`CREATE TABLE book (book_id INTEGER, book_name TEXT, book_category INTEGER, book_type INTEGER,
            book_date INTEGER, authors TEXT, main_author INTEGER, printed INTEGER, group_id INTEGER,
            hidden INTEGER, major_online INTEGER, minor_online INTEGER, major_ondisk INTEGER,
            minor_ondisk INTEGER, pdf_links TEXT, meta_data TEXT, parent INTEGER)`);
    for (const b of books) {
        db.run(
            `INSERT INTO book VALUES (?, ?, 1, 1, 800, NULL, NULL, 1, NULL, 0, 1, 0, ?, 0, NULL, NULL, NULL)`,
            [b.id, b.name, b.flagged === false ? 0 : 1],
        );
    }
    fs.mkdirSync(path.dirname(masterDb), { recursive: true });
    fs.writeFileSync(masterDb, db.export());
    db.close();
}

function writeBookFile(id: number): void {
    const bucket = id % 1000;
    const dir = path.join(root, "book", bucket < 100 ? String(bucket).padStart(3, "0") : String(bucket));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.db`), "book bytes");
}

function makeFreshness(): CatalogFreshness {
    return new CatalogFreshness({
        masterDbPath: masterDb,
        databaseRoot: root,
        db: getDb(),
        now: () => clock,
        checkIntervalMs: 2_000,
        failBackoffMs: 30_000,
    });
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shamela-freshness-"));
    masterDb = path.join(root, "master.db");
    clock = 1_000_000;
});

afterEach(() => {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe("catalog freshness", () => {
    it("returns the same catalog instance when nothing changed", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });

        const freshness = makeFreshness();
        clock += 10_000;
        expect(await freshness.ensureFresh(catalog)).toBe(catalog);
        expect(freshness.stats().reloads).toBe(0);
    });

    it("does not touch the disk again inside the check interval", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });
        const freshness = makeFreshness();

        clock += 10_000;
        await freshness.ensureFresh(catalog);
        const afterFirst = freshness.stats().checks;
        // A model can fire several tool calls a second; the human loop this is
        // watching for takes far longer than that.
        clock += 500;
        await freshness.ensureFresh(catalog);
        expect(freshness.stats().checks).toBe(afterFirst);
    });

    it("reloads when a book is added, and marks it as not yet searchable", async () => {
        await writeLibrary([{ id: 10, name: "الأول" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });
        expect(catalog.downloadedBookIds().size).toBe(1);

        const freshness = makeFreshness();
        // The user goes to Shamela and downloads a book.
        await writeLibrary([
            { id: 10, name: "الأول" },
            { id: 21, name: "الثاني" },
        ]);
        writeBookFile(21);
        fs.utimesSync(masterDb, new Date(), new Date());

        clock += 10_000;
        const next = await freshness.ensureFresh(catalog);
        expect(next).not.toBe(catalog);
        expect(next.downloadedBookIds().size).toBe(2);
        expect(next.isDownloaded(21)).toBe(true);
        // Its text lives in indexes the helper opened at startup, so it is
        // explicitly flagged rather than silently returning an empty page.
        expect(next.isSessionDiscovered(21)).toBe(true);
        expect(next.isSessionDiscovered(10)).toBe(false);
        expect(freshness.stats().reloads).toBe(1);
    });

    it("keeps the previous catalog when the reload fails", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });
        const freshness = makeFreshness();

        // Shamela is mid-write: the file is there but unreadable as a database.
        fs.writeFileSync(masterDb, "torn garbage");
        clock += 10_000;
        const next = await freshness.ensureFresh(catalog);

        // A failed refresh must not become an error in a request that had
        // nothing to do with it.
        expect(next).toBe(catalog);
        expect(next.bookCount()).toBe(1);
        expect(freshness.stats().failures).toBeGreaterThan(0);
        expect(freshness.stats().consecutive_failures).toBeGreaterThan(0);
    });

    it("backs off instead of retrying a broken file on every call", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });
        const freshness = makeFreshness();

        fs.writeFileSync(masterDb, "torn garbage");
        clock += 10_000;
        await freshness.ensureFresh(catalog);
        const afterFailure = freshness.stats().checks;

        clock += 3_000; // past the check interval, inside the failure backoff
        await freshness.ensureFresh(catalog);
        expect(freshness.stats().checks).toBe(afterFailure);
    });

    it("checks immediately when forced", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });
        const freshness = makeFreshness();

        await freshness.ensureFresh(catalog);
        const before = freshness.stats().checks;
        await freshness.ensureFresh(catalog, /* force */ true);
        expect(freshness.stats().checks).toBe(before + 1);
    });
});

describe("catalog treats the file as the authority", () => {
    it("counts a book whose file exists even with no master.db flag", async () => {
        // The reported library: copied in, so every flag is 0.
        await writeLibrary([{ id: 31, name: "منسوخ", flagged: false }]);
        writeBookFile(31);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });

        expect(catalog.isDownloaded(31)).toBe(true);
        expect(catalog.isFlaggedOnDisk(31)).toBe(false);
        expect(catalog.downloadedBookIds().size).toBe(1);
    });

    it("does not count a flagged book whose file is missing, and can name it", async () => {
        await writeLibrary([
            { id: 10, name: "سليم" },
            { id: 44, name: "مبتور" }, // flagged, but its file never arrived
        ]);
        writeBookFile(10); // so the library is readable, just missing this one
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });

        expect(catalog.isDownloaded(44)).toBe(false);
        expect(catalog.isFlaggedOnDisk(44)).toBe(true);
        expect(catalog.flaggedFileMissingIds()).toEqual([44]);
    });

    it("keeps stray files out of the book list but still reports them", async () => {
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        writeBookFile(10);
        writeBookFile(88_888); // a file with no catalog row
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });

        // Listing it would produce a nameless, authorless entry.
        expect(catalog.isDownloaded(88_888)).toBe(false);
        expect(catalog.orphanFileIds()).toEqual([88_888]);
    });

    it("falls back to the flags when the book folder cannot be read at all", async () => {
        // Wrong path, permissions, a disconnected drive — the library has not
        // vanished, and saying it has would be worse than the flag's staleness.
        await writeLibrary([{ id: 10, name: "كتاب" }]);
        const catalog = await Catalog.load(masterDb, getDb(), { databaseRoot: root });

        expect(catalog.diskScanFellBack()).toBe(true);
        expect(catalog.isDownloaded(10)).toBe(true);
    });
});

/**
 * The distinction the coverage receipt exists for, tested where it can be.
 *
 * A school reports zero for two opposite reasons — its books are here and say
 * nothing, or its books are not here at all — and on a real install this
 * machine cannot show the second: every madhhab book in the catalogue is
 * downloaded (87/87, 89/89, 90/90, 153/153), so the live test can only ever
 * see «found». The synthetic library has Shafii and Hanbali books and no
 * Hanafi or Maliki ones at all, which is precisely the shape needed.
 *
 * The engine is stubbed, and deliberately: what is under test is the reading
 * of a rollup, not the producing of one.
 */

import * as path from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { Catalog } from "../../src/server/catalog.js";
import type { Helper } from "../../src/server/helper.js";
import { runResearchScope, researchScopeInput, schoolStatus } from "../../src/server/tools/researchScope.js";
import { SYN, SYN_CATEGORY, createSyntheticLibrary, type SyntheticLibrary } from "../fixtures/synthetic-library.js";
import { getDb } from "../fixtures/shared.js";

let lib: SyntheticLibrary;
let catalog: Catalog;

beforeAll(async () => {
    lib = await createSyntheticLibrary();
    catalog = await Catalog.load(path.join(lib.database, "master.db"), getDb(), {
        databaseRoot: lib.database,
    });
}, 60_000);

afterAll(() => lib?.cleanup());

/**
 * An engine that returns exactly the rollup it is told to.
 *
 * `byBook` maps book id → pages, per query, so a test can say «this term is in
 * that Shafii book and nowhere else» and then check what the receipt makes of
 * it.
 */
function stubHelper(byBook: Record<string, Record<number, number>>): Helper {
    return {
        request: async (_cmd: string, args: Record<string, unknown>) => {
            const rollup = byBook[String(args.query)] ?? {};
            const by_book_key: Record<string, number> = {};
            let total = 0;
            for (const [id, pages] of Object.entries(rollup)) {
                by_book_key[id] = pages;
                total += pages;
            }
            return {
                total_hits: total,
                normalized_tokens: [String(args.query)],
                coverage: { by_book_key, total_seen: total, at_cap: false, basis: "all_results" },
            };
        },
    } as unknown as Helper;
}

const receipt = (helper: Helper, args: Record<string, unknown>) =>
    runResearchScope(helper, catalog, researchScopeInput.parse({ response_format: "json", ...args })).then(
        (r) => r.structuredContent,
    );

const rowFor = (out: Awaited<ReturnType<typeof receipt>>, school: string) =>
    out.schools.find((s) => s.madhhab === school)!;

describe("the two zeros are never the same zero", () => {
    it("calls a school silent only when its books are on the machine", async () => {
        // SYN.PADDED is a Shafii book and it holds the term; the Hanbali book
        // is here and does not.
        const out = await receipt(stubHelper({ "الاستصناع": { [SYN.PADDED]: 7 } }), { term: "الاستصناع" });
        expect(rowFor(out, "shafii").status).toBe("found");
        expect(rowFor(out, "hanbali").status).toBe("silent");
        expect(rowFor(out, "hanbali").books_downloaded).toBeGreaterThan(0);
        expect(rowFor(out, "hanbali").books_with_hits).toBe(0);
    });

    it("refuses to call a school silent when it holds none of its books", async () => {
        const out = await receipt(stubHelper({ "الاستصناع": { [SYN.PADDED]: 7 } }), { term: "الاستصناع" });
        for (const school of ["hanafi", "maliki"]) {
            expect(rowFor(out, school).status, school).toBe("cannot_tell");
            expect(rowFor(out, school).books_downloaded, school).toBe(0);
        }
    });

    it("reports all four schools even when three of them are empty", async () => {
        const out = await receipt(stubHelper({ x: { [SYN.PADDED]: 1 } }), { term: "xy" });
        expect(out.schools.map((s) => s.madhhab)).toEqual(["hanafi", "maliki", "shafii", "hanbali"]);
    });

    it("warns, in words, whenever a row cannot be read as silence", async () => {
        const out = await receipt(stubHelper({}), { term: "الاستصناع" });
        expect(out.caveats.join(" ")).toMatch(/لا يدلّ على شيء|shows nothing/);
    });
});

describe("what the four rows leave out", () => {
    it("counts the pages that fall outside every school", async () => {
        // SYN.PLAIN is a general-fiqh book: outside all four categories, and a
        // receipt that hid it would invite the rows to be read as a total.
        const out = await receipt(
            stubHelper({ "الاستصناع": { [SYN.PADDED]: 3, [SYN.PLAIN]: 5 } }),
            { term: "الاستصناع" },
        );
        expect(out.outside_the_schools.pages_by_term["الاستصناع"]).toBe(5);
        expect(out.outside_the_schools.books_with_hits).toBe(1);
        const inSchools = out.schools.reduce((n, s) => n + (s.pages_by_term["الاستصناع"] ?? 0), 0);
        expect(inSchools + out.outside_the_schools.pages_by_term["الاستصناع"]!).toBe(
            out.total_by_term["الاستصناع"],
        );
    });
});

describe("more than one wording", () => {
    it("keeps each wording in its own column rather than adding them up", async () => {
        // Adding them would count a page carrying both terms twice.
        const out = await receipt(
            stubHelper({
                "خيار المجلس": { [SYN.PADDED]: 4 },
                "خيار المتبايعين": { [SYN.MULTI]: 6 },
            }),
            { term: "خيار المجلس", synonyms: ["خيار المتبايعين"] },
        );
        const shafii = rowFor(out, "shafii");
        expect(shafii.pages_by_term).toEqual({ "خيار المجلس": 4, "خيار المتبايعين": 6 });
        // Two books of the same school, reached by different wordings.
        expect(shafii.books_with_hits).toBe(2);
    });

    it("says so when only one wording was measured", async () => {
        const one = await receipt(stubHelper({ "الاستصناع": { [SYN.PADDED]: 1 } }), { term: "الاستصناع" });
        expect(one.caveats.join(" ")).toMatch(/مرادفات|synonyms/);
        const two = await receipt(
            stubHelper({ a: { [SYN.PADDED]: 1 }, b: { [SYN.PADDED]: 1 } }),
            { term: "aa", synonyms: ["bb"] },
        );
        expect(two.caveats.join(" ")).not.toMatch(/قِيس اللفظ الواحد|Only one wording/);
    });

    it("drops a synonym that repeats the term rather than measuring it twice", async () => {
        const out = await receipt(stubHelper({ "الاستصناع": { [SYN.PADDED]: 2 } }), {
            term: "الاستصناع",
            synonyms: ["الاستصناع"],
        });
        expect(out.terms).toEqual(["الاستصناع"]);
    });
});

describe("a sampled distribution is not passed off as a count", () => {
    it("names the terms whose rollup the engine only sampled", async () => {
        const sampling = {
            request: async () => ({
                total_hits: 900_000,
                normalized_tokens: ["x"],
                coverage: { by_book_key: { [SYN.PADDED]: 5 }, total_seen: 5, at_cap: true, basis: "window" },
            }),
        } as unknown as Helper;
        const out = await receipt(sampling, { term: "الصلاة" });
        expect(out.sampled_terms).toEqual(["الصلاة"]);
        expect(out.caveats.join(" ")).toMatch(/عيّنةٌ|a sample/);
    });
});

describe("what the reader sees", () => {
    it("puts the reading note above the table", async () => {
        const r = await runResearchScope(
            stubHelper({ "الاستصناع": { [SYN.PADDED]: 3 } }),
            catalog,
            researchScopeInput.parse({ term: "الاستصناع" }),
        );
        const text = r.content[0]!.text;
        expect(text.indexOf("أصفار")).toBeGreaterThan(-1);
        expect(text.indexOf("أصفار")).toBeLessThan(text.indexOf("|---"));
    });

    it("renders the empty schools as rows, not as absences", async () => {
        const r = await runResearchScope(
            stubHelper({ "الاستصناع": { [SYN.PADDED]: 3 } }),
            catalog,
            researchScopeInput.parse({ term: "الاستصناع" }),
        );
        const text = r.content[0]!.text;
        expect(text).toContain("حنفي");
        expect(text).toContain("مالكي");
        expect(text).toMatch(/لا يُدرى/);
    });
});

describe("the four statuses, as a truth table", () => {
    // Both wrong answers this tool has produced were orderings of these four
    // lines: first a scoped-out school read as «silent», then — in the fix for
    // that — a school with nothing on disk read as «silent». A table is the
    // only way to see an ordering whole.
    const cases: Array<[number, number, number, string, string]> = [
        // hits, searched, downloaded, expected, why
        [3, 5, 5, "found", "pages were hit"],
        [1, 1, 9, "found", "one hit is a hit, whatever the rest"],
        [0, 5, 5, "silent", "its books were read and say nothing"],
        [0, 2, 9, "silent", "some of its books were read; that much is evidence"],
        [0, 0, 9, "not_searched", "here, but the scope left them out"],
        [0, 0, 1, "not_searched", "one book here, unscoped-out"],
        [0, 0, 0, "cannot_tell", "nothing of it is here at all"],
    ];
    for (const [hits, searched, downloaded, expected, why] of cases) {
        it(`hits=${hits} searched=${searched} downloaded=${downloaded} → ${expected} (${why})`, () => {
            expect(schoolStatus(hits, searched, downloaded)).toBe(expected);
        });
    }

    it("never calls a school silent unless something of it was read", () => {
        // The one forbidden sentence. `searched` is the only gate on it, so
        // whatever `downloaded` says, zero read means never silent.
        for (const downloaded of [0, 1, 50, 153]) {
            expect(schoolStatus(0, 0, downloaded), `downloaded=${downloaded}`).not.toBe("silent");
        }
    });
});

describe("a scope names catalogue books, not books on the disk", () => {
    it("does not call a school silent for books the scope named and the disk lacks", async () => {
        // The regression: a scope resolves against the CATALOGUE, which ships
        // complete before anything is downloaded. Counting those as searched
        // made a school with nothing here report «its books were searched and
        // say nothing» — the inversion this tool exists to prevent, pointing
        // the other way. SYN.CATALOGUED_ONLY is a Hanafi book in the catalogue
        // with no file behind it.
        const out = await receipt(stubHelper({}), {
            term: "الاستصناع",
            scope: { category_ids: [SYN_CATEGORY.HANAFI, SYN_CATEGORY.SHAFII] },
        });
        const hanafi = rowFor(out, "hanafi");
        expect(hanafi.books_in_catalogue).toBeGreaterThan(0);
        expect(hanafi.books_downloaded).toBe(0);
        expect(hanafi.books_searched).toBe(0);
        expect(hanafi.status).toBe("cannot_tell");
        // And the warning that goes with that status is present.
        expect(out.caveats.join(" ")).toMatch(/لا يدلّ على شيء|shows nothing/);
    });

    it("keeps books_searched within books_downloaded, always", async () => {
        const out = await receipt(stubHelper({}), {
            term: "الاستصناع",
            scope: { category_ids: [SYN_CATEGORY.HANAFI, SYN_CATEGORY.SHAFII, SYN_CATEGORY.HANBALI] },
        });
        for (const row of out.schools) {
            expect(row.books_searched, row.madhhab).toBeLessThanOrEqual(row.books_downloaded);
        }
    });

    it("counts the header's searched books the same way the rows do", async () => {
        // «searched 7 of 6 downloaded» is an impossible sentence; the header
        // and the rows must measure the same thing.
        const out = await receipt(stubHelper({}), {
            term: "الاستصناع",
            scope: { category_ids: [SYN_CATEGORY.HANAFI, SYN_CATEGORY.SHAFII] },
        });
        expect(out.searched.books).toBeLessThanOrEqual(out.searched.downloaded_total);
        const inRows = out.schools.reduce((n, s) => n + s.books_searched, 0);
        expect(out.searched.books).toBeGreaterThanOrEqual(inRows);
    });
});

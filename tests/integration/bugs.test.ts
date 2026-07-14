/**
 * Regression tests for bugs reported via real-world tool exercise.
 * Per CLAUDE.md "Testing rules" §3 — every reported bug becomes a test
 * here BEFORE the fix lands.
 */

import { describe, it, expect, beforeAll } from "vitest";

import type { Catalog } from "../../src/server/catalog.js";
import { runSearchBooks } from "../../src/server/tools/searchBooks.js";
import type { Helper } from "../../src/server/helper.js";
import { getCatalog, getHelper } from "../fixtures/shared.js";

describe("Bug #2 — search_books must honor scope in total_hits/has_more/next_offset", () => {
    let helper: Helper;
    let catalog: Catalog;

    beforeAll(async () => {
        helper = await getHelper();
        catalog = await getCatalog();
    });

    // The reproducer: query "الأصول من علم الأصول" returns 8 hits unscoped
    // (per user-reported repro), only 1 of which is by Ibn Uthaymeen (book 9942).
    // Before the fix: scoped total_hits=8, has_more=true, next_offset=0 — all wrong.
    // After the fix: scoped total_hits=1, has_more=false, no next_offset.
    const QUERY = "الأصول من علم الأصول";
    const IBN_UTHAYMEEN_ID = 57;

    it("scoped total_hits == count of returned scope-matching books, not pre-scope total", async () => {
        const unscoped = await runSearchBooks(helper, catalog, {
            query: QUERY,
            limit: 100,
            offset: 0,
            response_format: "json",
        });
        // Unscoped baseline: there is at least one match across the catalog.
        expect(unscoped.structuredContent.total_hits).toBeGreaterThan(0);

        const scoped = await runSearchBooks(helper, catalog, {
            query: QUERY,
            scope: { author_ids: [IBN_UTHAYMEEN_ID], downloaded_only: false },
            limit: 100,
            offset: 0,
            response_format: "json",
        });

        // Every returned book must actually be by author 57.
        const author57Books = catalog.booksByAuthors([IBN_UTHAYMEEN_ID]);
        for (const r of scoped.structuredContent.results) {
            expect(
                author57Books.has(r.book_id),
                `book ${r.book_id} returned but not in author 57's books`,
            ).toBe(true);
        }

        // total_hits must equal the actual scoped result count (not pre-scope total).
        expect(scoped.structuredContent.total_hits).toBe(
            scoped.structuredContent.results.length,
        );

        // returned must equal the result list length.
        expect(scoped.structuredContent.returned).toBe(
            scoped.structuredContent.results.length,
        );

        // Scoped total_hits must be ≤ unscoped (by definition).
        expect(scoped.structuredContent.total_hits).toBeLessThanOrEqual(
            unscoped.structuredContent.total_hits,
        );
    });

    it("limit=3 with restrictive scope still surfaces the matching book on page 1", async () => {
        // The user's reproducer: with limit=3 and scope=author 57, the broken
        // version returned `returned=0, has_more=true, next_offset=0` even though
        // book 9942 IS in the scoped result set — the helper had pre-paginated the
        // unscoped results, all 3 of which happened to be other authors' books.
        const r = await runSearchBooks(helper, catalog, {
            query: QUERY,
            scope: { author_ids: [IBN_UTHAYMEEN_ID], downloaded_only: false },
            limit: 3,
            offset: 0,
            response_format: "json",
        });

        // If anything matched the scope at all, page 1 must contain it.
        if (r.structuredContent.total_hits > 0) {
            expect(r.structuredContent.results.length).toBeGreaterThan(0);
        }
    });

    it("has_more / next_offset are correct on the scoped result set, not the pre-scope set", async () => {
        const r = await runSearchBooks(helper, catalog, {
            query: QUERY,
            scope: { author_ids: [IBN_UTHAYMEEN_ID], downloaded_only: false },
            limit: 100,
            offset: 0,
            response_format: "json",
        });

        // Once we ask for more than the total, has_more must be false and there
        // must be no next_offset.
        if (r.structuredContent.results.length === r.structuredContent.total_hits) {
            expect(r.structuredContent.has_more).toBe(false);
            expect(r.structuredContent.next_offset).toBeUndefined();
        }
    });
});

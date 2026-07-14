/**
 * Experimental-features check: Quran prefix-insensitive search + phrase/near
 * search. Runs against the local Shamela install (same setup as smoke.ts).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

import { Catalog } from "../src/server/catalog.js";
import { Helper } from "../src/server/helper.js";
import { PageStore } from "../src/server/pages.js";
import { resolveAll } from "../src/server/paths.js";
import { ServiceStore } from "../src/server/services.js";
import { searchQuranInput, runSearchQuran } from "../src/server/tools/searchQuran.js";
import { searchPhraseInput, runSearchPhrase } from "../src/server/tools/searchPhrase.js";
import { searchPagesInput, runSearchPages } from "../src/server/tools/searchPages.js";
import { searchHadithInput, runSearchHadith } from "../src/server/tools/searchHadith.js";
import { getBookInput, runGetBook } from "../src/server/tools/getBook.js";
import { getCitationInput, runGetCitation } from "../src/server/tools/getCitation.js";
import { getPageInput, runGetPage } from "../src/server/tools/getPage.js";
import { getTafseerOfAyaInput, runGetTafseerOfAya } from "../src/server/tools/getTafseerOfAya.js";
import { listCategoriesInput, runListCategories } from "../src/server/tools/listCategories.js";
import { listDownloadedBooksInput, runListDownloadedBooks } from "../src/server/tools/listDownloadedBooks.js";
import { getChunk, trimPagesByBudget } from "../src/server/longtext.js";
import { healthInput, runHealth } from "../src/server/tools/health.js";
import { searchExactInput, runSearchExact, normalizeExact } from "../src/server/tools/searchExact.js";
import { searchBooleanInput, runSearchBoolean } from "../src/server/tools/searchBoolean.js";
import { rootStatsInput, runRootStats } from "../src/server/tools/rootStats.js";
import { booksByPeriodInput, runBooksByPeriod } from "../src/server/tools/booksByPeriod.js";

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
    console.log(`${ok ? "[OK]" : "[FAIL]"} ${label}${detail ? `  —  ${detail}` : ""}`);
    if (!ok) failures.push(label);
}

async function main(): Promise<number> {
    const paths = await resolveAll();
    if (!fs.existsSync(paths.helperJar)) {
        console.error(`helper jar missing: ${paths.helperJar}`);
        return 1;
    }
    const sqlWasm = new Uint8Array(fs.readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")));
    const helper = new Helper({ paths });
    const catalog = await Catalog.load(path.join(paths.database, "master.db"), sqlWasm);
    const pages = new PageStore(paths.database, sqlWasm);
    const services = new ServiceStore(paths.database, sqlWasm);

    try {
        await helper.ready(20_000);

        // 1. Quran: bare "الصبر" used to return 0; now should find "بالصبر" etc.
        const q1 = await runSearchQuran(helper, searchQuranInput.parse({ query: "الصبر", response_format: "json" }));
        check("quran 'الصبر' now returns hits (prefix-insensitive)", q1.structuredContent.total_hits > 0,
            `total=${q1.structuredContent.total_hits}`);
        const sample = q1.structuredContent.results.slice(0, 4).map((r) => `${r.surah_name} ${r.surah}:${r.aya}`).join(" | ");
        console.log(`       sample: ${sample}`);

        // 2. Quran: sanity — a normal query still works.
        const q2 = await runSearchQuran(helper, searchQuranInput.parse({ query: "الرحمن", response_format: "json" }));
        check("quran 'الرحمن' still works", q2.structuredContent.total_hits > 0, `total=${q2.structuredContent.total_hits}`);

        // 3. Phrase: exact "الأعمال بالنيات" (known present in usul books).
        const p1 = await runSearchPhrase(helper, catalog, pages,
            searchPhraseInput.parse({ query: "الأعمال بالنيات", mode: "phrase", limit: 10, response_format: "json" }));
        check("phrase 'الأعمال بالنيات' finds matches", p1.structuredContent.returned > 0,
            `returned=${p1.structuredContent.returned} scanned=${p1.structuredContent.total_candidates_scanned}`);
        if (p1.structuredContent.results[0]) {
            const r = p1.structuredContent.results[0];
            console.log(`       first: ${r.book_name} (${r.printed_page}) — ${r.author_name}`);
        }

        // 4. Phrase: reversed order must NOT match as an exact phrase.
        const p2 = await runSearchPhrase(helper, catalog, pages,
            searchPhraseInput.parse({ query: "بالنيات الأعمال", mode: "phrase", limit: 10, response_format: "json" }));
        check("reversed phrase 'بالنيات الأعمال' yields 0 (phrase order enforced)",
            p2.structuredContent.returned === 0, `returned=${p2.structuredContent.returned}`);

        // 5. Near: same two words within 5 words, any order — should match.
        const p3 = await runSearchPhrase(helper, catalog, pages,
            searchPhraseInput.parse({ query: "بالنيات الأعمال", mode: "near", distance: 5, limit: 10, response_format: "json" }));
        check("near 'بالنيات الأعمال' (distance 5, any order) finds matches",
            p3.structuredContent.returned > 0, `returned=${p3.structuredContent.returned}`);

        // 6. Perf: search_pages with batched printed-page enrichment (N+1 fix).
        const t0 = Date.now();
        const sp = await runSearchPages(helper, catalog, pages,
            searchPagesInput.parse({ query: "الصلاة", limit: 50, response_format: "json" }));
        const dt = Date.now() - t0;
        const allHavePrinted = sp.structuredContent.results.every((r) => r.printed_page !== undefined);
        check("search_pages returns hits with printed_page (N+1 batch fix)",
            sp.structuredContent.returned > 0 && allHavePrinted,
            `returned=${sp.structuredContent.returned} total=${sp.structuredContent.total_hits} time=${dt}ms`);

        // 7. Hadith by text.
        const sh = await runSearchHadith(helper, catalog, pages, services,
            searchHadithInput.parse({ query: "إنما الأعمال بالنيات", response_format: "json" }));
        check("search_hadith('إنما الأعمال بالنيات') finds text matches",
            sh.structuredContent.total_text_matches > 0,
            `matches=${sh.structuredContent.total_text_matches} takhrij_keys=${sh.structuredContent.takhrij.length}`);

        // 8. get_book enrichment (Bug 6 content_status + Proposal 18 edition/editor/publisher).
        for (const bid of [7798, 1461, 9879]) {
            const gb = await runGetBook(catalog, pages, helper, getBookInput.parse({ book_id: bid, response_format: "json" }));
            const c = gb.structuredContent;
            check(`get_book(${bid}) → content_status + publication enrichment`,
                c.content_status === "readable",
                `status=${c.content_status} | edition=${c.edition} | editor=${c.editor} | publisher=${c.publisher}`);
        }

        // 9. get_citation enrichment (Proposal 18): muḥaqqiq surfaced from the Shamela name.
        const cit = await runGetCitation(catalog, pages,
            getCitationInput.parse({ book_id: 7798, page_id: 2936, style: "full", response_format: "json" }));
        check("get_citation(7798, full) surfaces muḥaqqiq from name",
            cit.structuredContent.notes.some((n) => n.includes("التركي")),
            cit.structuredContent.notes.slice(0, 2).join(" | "));

        // 10. longtext helpers (Proposal 15 — pure unit checks).
        const c1 = getChunk("ف".repeat(9000), 1, 4000);
        check("getChunk splits a 9000-char body into parts", c1.total_parts >= 2 && c1.has_more === true,
            `total_parts=${c1.total_parts} has_more=${c1.has_more}`);
        const c2 = getChunk("نص قصير", 1, 4000);
        check("getChunk keeps short text as a single part", c2.total_parts === 1 && c2.has_more === false);
        const tp = trimPagesByBudget(
            [{ body: "ا".repeat(7000), foot: "" }, { body: "ب".repeat(7000), foot: "" }, { body: "ج", foot: "" }],
            12_000);
        check("trimPagesByBudget stops within the char budget", tp.trimmed === true && tp.kept.length === 1,
            `kept=${tp.kept.length} trimmed=${tp.trimmed}`);

        // 11. list_categories reports per-category downloaded counts (category-aware).
        const lc = runListCategories(catalog, listCategoriesInput.parse({ downloaded_only: true, response_format: "json" }));
        const tafsirCat = lc.structuredContent.categories.find((c) => c.category_id === 3);
        check("list_categories(downloaded_only) shows tafsir (cat 3) with downloads",
            lc.structuredContent.downloaded_total > 0 && !!tafsirCat && tafsirCat.downloaded_count > 0,
            `downloaded_total=${lc.structuredContent.downloaded_total} tafsir_dl=${tafsirCat?.downloaded_count}`);

        // 12. list_downloaded_books category filter + content_status + library_by_category.
        const ld = await runListDownloadedBooks(catalog, pages,
            listDownloadedBooksInput.parse({ category_id: 3, limit: 20, response_format: "json" }));
        check("list_downloaded_books(category_id=3) returns tafsirs with content_status + distribution",
            ld.structuredContent.returned > 0 &&
                ld.structuredContent.books.every((bk) => bk.category_id === 3) &&
                ld.structuredContent.books.every((bk) => bk.content_status === "readable" || bk.content_status === "downloaded_no_pages") &&
                ld.structuredContent.library_by_category.length > 0,
            `returned=${ld.structuredContent.returned} cats=${ld.structuredContent.library_by_category.length}`);

        // 13. get_page exposes body pagination fields (Proposal 15).
        const gp = await runGetPage(helper, catalog, pages,
            getPageInput.parse({ book_id: 1461, page_id: 1, response_format: "json" }));
        check("get_page returns body_part/body_total_parts fields",
            typeof gp.structuredContent.body_total_parts === "number" && gp.structuredContent.body_part === 1,
            `parts=${gp.structuredContent.body_total_parts} has_more=${gp.structuredContent.body_has_more}`);

        // 14. get_tafseer_of_aya carries the honest coverage caveat (Bug 5).
        const gt = await runGetTafseerOfAya(catalog, services,
            getTafseerOfAyaInput.parse({ surah: 1, aya: 1, downloaded_only: false, response_format: "json" }));
        check("get_tafseer_of_aya includes coverage_note (curated-index caveat)",
            typeof gt.structuredContent.coverage_note === "string" && gt.structuredContent.coverage_note.includes("منتقى"),
            `note_len=${gt.structuredContent.coverage_note?.length}`);

        // 15. health tool (v1.3.0-exp — field-report diagnostics).
        const h = await runHealth(catalog, pages, healthInput.parse({ response_format: "json" }));
        check("health reports version + counts + readable spot-check",
            h.structuredContent.server_version === "1.4.0-exp" &&
                h.structuredContent.downloaded_books > 0 &&
                h.structuredContent.status === "ok" &&
                (h.structuredContent.readable_spot_check?.readable ?? 0) > 0,
            `v=${h.structuredContent.server_version} dl=${h.structuredContent.downloaded_books} spot=${JSON.stringify(h.structuredContent.readable_spot_check)}`);

        // 16. search_exact: preserve_hamza returns hits whose snippets keep the EXACT hamza «أحمد».
        //     (An all-false preserve is rejected by design — the folded baseline is search_pages, not search_exact.)
        const exOn = await runSearchExact(helper, catalog, pages,
            searchExactInput.parse({ query: "أحمد", preserve: { preserve_hamza: true }, scope: { category_ids: [17] }, limit: 20, response_format: "json" }));
        check("search_exact(preserve_hamza 'أحمد') returns hits whose snippets keep the exact hamza",
            exOn.structuredContent.returned > 0 &&
                exOn.structuredContent.results.every((r) =>
                    normalizeExact(r.snippet, { preserve_diacritics: false, preserve_hamza: true, preserve_digits: false }).includes("أحمد")),
            `returned=${exOn.structuredContent.returned} scanned=${exOn.structuredContent.total_candidates_scanned} cap=${exOn.structuredContent.candidate_cap_hit}`);

        // 17. search_boolean: any_of (OR) ≥ the larger single-term window.
        const single1 = await runSearchPages(helper, catalog, pages,
            searchPagesInput.parse({ query: "الرهن", scope: { category_ids: [17] }, limit: 50, response_format: "json" }));
        const orRes = await runSearchBoolean(helper, catalog, pages,
            searchBooleanInput.parse({ any_of: ["الرهن", "الضمان"], scope: { category_ids: [17] }, limit: 50, response_format: "json" }));
        check("search_boolean any_of('الرهن','الضمان') ≥ single 'الرهن' window (OR widens)",
            orRes.structuredContent.total_in_window >= Math.min(single1.structuredContent.returned, 50),
            `or=${orRes.structuredContent.total_in_window} single=${single1.structuredContent.returned}`);

        // 18. search_boolean: none_of never increases the surviving window (NOT excludes).
        const withExcl = await runSearchBoolean(helper, catalog, pages,
            searchBooleanInput.parse({ any_of: ["الرهن", "الضمان"], none_of: ["البيع"], scope: { category_ids: [17] }, limit: 50, response_format: "json" }));
        check("search_boolean none_of('البيع') does not increase the window (NOT excludes)",
            withExcl.structuredContent.total_in_window <= orRes.structuredContent.total_in_window &&
                typeof withExcl.structuredContent.candidate_cap_hit === "boolean",
            `excluded=${withExcl.structuredContent.total_in_window} base=${orRes.structuredContent.total_in_window}`);

        // 19. root_stats: morphological distribution for a common root.
        const rst = await runRootStats(helper, catalog,
            rootStatsInput.parse({ root: "صبر", response_format: "json" }));
        check("root_stats('صبر') returns a non-empty distribution",
            rst.structuredContent.total_hits > 0 &&
                rst.structuredContent.by_category.length > 0 &&
                rst.structuredContent.by_book.length > 0,
            `total=${rst.structuredContent.total_hits} counted=${rst.structuredContent.total_counted} books=${rst.structuredContent.books_matched} capped=${rst.structuredContent.coverage_capped}`);

        // 20. books_by_period: composed-year vs death-year kept distinct (Proposal 9).
        const bp = runBooksByPeriod(catalog,
            booksByPeriodInput.parse({ died_from: 700, died_to: 800, limit: 100, response_format: "json" }));
        check("books_by_period(died 700..800) returns hits, all within the death-year range",
            bp.structuredContent.total > 0 &&
                bp.structuredContent.books.length > 0 &&
                bp.structuredContent.books.every((bk) =>
                    bk.main_author_death_year !== null &&
                    bk.main_author_death_year >= 700 &&
                    bk.main_author_death_year <= 800),
            `total=${bp.structuredContent.total} returned=${bp.structuredContent.returned}`);
    } catch (err) {
        failures.push(`uncaught: ${(err as Error).message}\n${(err as Error).stack}`);
    } finally {
        await helper.close();
        pages.close();
        services.close();
    }

    console.log(failures.length === 0 ? "\nALL PASS" : `\nFAILURES (${failures.length}):\n  - ${failures.join("\n  - ")}`);
    return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });

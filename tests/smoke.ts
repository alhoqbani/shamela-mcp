/**
 * shamela-mcp smoke test.
 *
 * Drives every one of the 20 tool handlers through its run-function — same
 * code path as the registered MCP tools, but without the MCP server frame.
 * Boots the Java helper subprocess, the Catalog, the PageStore (sql.js), and
 * the ServiceStore once; tears them down at the end.
 *
 * Test fixture: book 9942 (الأصول من علم الأصول، ابن عثيمين). Empirical
 * shape (Phase 0.3 catalog survey, validated against C:\shamela4):
 *   - 23 top-level chapter titles
 *   - single-volume (page.part is null throughout)
 *   - 0 services annotations on any page
 *   - "الكلام" → 9 page hits
 *
 * Exits 0 if every assertion passes, 1 with a diagnostic listing on any
 * failure. Output is appended-friendly: each line either "[OK] ..." or
 * "[FAIL] ...".
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

import { Catalog } from "../src/server/catalog.js";
import { Helper } from "../src/server/helper.js";
import { PageStore } from "../src/server/pages.js";
import { resolveAll, ShamelaNotFoundError } from "../src/server/paths.js";
import { ServiceStore } from "../src/server/services.js";

import { getAuthorInput, runGetAuthor } from "../src/server/tools/getAuthor.js";
import { getAyaInput, runGetAya } from "../src/server/tools/getAya.js";
import { getBookInput, runGetBook } from "../src/server/tools/getBook.js";
import { getBookPartsInput, runGetBookParts } from "../src/server/tools/getBookParts.js";
import { getBookSectionInput, runGetBookSection } from "../src/server/tools/getBookSection.js";
import { getBooksForHadithInput, runGetBooksForHadith } from "../src/server/tools/getBooksForHadith.js";
import { getCitationInput, runGetCitation } from "../src/server/tools/getCitation.js";
import { getPageInput, runGetPage } from "../src/server/tools/getPage.js";
import { getPageServicesInput, runGetPageServices } from "../src/server/tools/getPageServices.js";
import { getPagesRangeInput, runGetPagesRange } from "../src/server/tools/getPagesRange.js";
import { getTafseerOfAyaInput, runGetTafseerOfAya } from "../src/server/tools/getTafseerOfAya.js";
import { getTocInput, runGetToc } from "../src/server/tools/getToc.js";
import { listCategoriesInput, runListCategories } from "../src/server/tools/listCategories.js";
import { listDownloadedBooksInput, runListDownloadedBooks } from "../src/server/tools/listDownloadedBooks.js";
import { resolveInput, runResolve } from "../src/server/tools/resolve.js";
import { searchAuthorsInput, runSearchAuthors } from "../src/server/tools/searchAuthors.js";
import { searchBooksInput, runSearchBooks } from "../src/server/tools/searchBooks.js";
import { searchPagesInput, runSearchPages } from "../src/server/tools/searchPages.js";
import { searchQuranInput, runSearchQuran } from "../src/server/tools/searchQuran.js";
import { searchTitlesInput, runSearchTitles } from "../src/server/tools/searchTitles.js";

const failures: string[] = [];
let assertionsRun = 0;

function check(label: string, ok: boolean, detail = ""): void {
    assertionsRun++;
    if (ok) {
        console.log(`[OK] ${label}${detail ? `  —  ${detail}` : ""}`);
    } else {
        console.log(`[FAIL] ${label}${detail ? `  —  ${detail}` : ""}`);
        failures.push(label);
    }
}

async function main(): Promise<number> {
    console.log("=".repeat(72));
    console.log("shamela-mcp smoke test (20 tools)");
    console.log(`Node:  ${process.version}`);
    console.log(`Plat:  ${process.platform} ${process.arch}`);
    console.log("=".repeat(72));

    let paths;
    try {
        paths = await resolveAll();
    } catch (err) {
        if (err instanceof ShamelaNotFoundError) console.error(err.message);
        else console.error("paths:", (err as Error).message);
        return 1;
    }
    if (!fs.existsSync(paths.helperJar)) {
        console.error(`helper jar missing: ${paths.helperJar}\nRun: npm run build:java`);
        return 1;
    }
    const sqlWasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const sqlWasm = new Uint8Array(fs.readFileSync(sqlWasmPath));

    const helper = new Helper({ paths });
    const catalog = await Catalog.load(path.join(paths.database, "master.db"), sqlWasm);
    const pages = new PageStore(paths.database, sqlWasm);
    const services = new ServiceStore(paths.database, sqlWasm);

    console.log(
        `catalog: ${catalog.bookCount()} books, ${catalog.authorCount()} authors, ${catalog.categoryCount()} categories`,
    );
    const downloadedIds = Array.from(catalog.downloadedBookIds()).sort((a, b) => a - b);
    console.log(`downloaded: ${downloadedIds.length} (first: ${downloadedIds.slice(0, 5).join(",")})`);

    try {
        await helper.ready(20_000);

        // ---------------- 9. list_categories ----------------
        const cats = runListCategories(catalog, listCategoriesInput.parse({ include_counts: true, response_format: "json" }));
        const catTotal = cats.structuredContent.total;
        check("list_categories total > 0", catTotal > 0, `total=${catTotal}`);
        const fiqhCat = cats.structuredContent.categories.find((c) => c.category_name.includes("فقه"));
        check("list_categories contains فقه", fiqhCat !== undefined, fiqhCat ? `id=${fiqhCat.category_id} count=${fiqhCat.book_count}` : "");

        // ---------------- 18. list_downloaded_books ----------------
        const dl = runListDownloadedBooks(catalog, listDownloadedBooksInput.parse({ limit: 100, offset: 0, response_format: "json" }));
        check("list_downloaded_books contains 9942", dl.structuredContent.books.some((b) => b.book_id === 9942));
        const dlMd = runListDownloadedBooks(
            catalog,
            listDownloadedBooksInput.parse({ limit: 100, offset: 0, response_format: "markdown" }),
        );
        check(
            "list_downloaded_books markdown render",
            dlMd.content[0]!.text.includes("الكتب المنزَّلة"),
            `chars=${dlMd.content[0]!.text.length}`,
        );

        // ---------------- 7. get_book ----------------
        const book = runGetBook(catalog, getBookInput.parse({ book_id: 9942, response_format: "json" }));
        check(
            "get_book(9942) name",
            book.structuredContent.book_name === "الأصول من علم الأصول",
            book.structuredContent.book_name,
        );
        check("get_book(9942) downloaded", book.structuredContent.downloaded === true);
        check(
            "get_book(9942) notes lists missing publisher/edition",
            book.structuredContent.notes.length >= 4,
        );
        const ibnUthaymeen = book.structuredContent.authors[0]!;
        const authorId = ibnUthaymeen.author_id;
        check(
            "get_book(9942) main author present",
            ibnUthaymeen.author_name.includes("عثيمين") || ibnUthaymeen.author_name.includes("صالح"),
            `id=${authorId} name=${ibnUthaymeen.author_name}`,
        );

        // ---------------- 8. get_author ----------------
        const author = runGetAuthor(
            catalog,
            getAuthorInput.parse({ author_id: authorId, include_books: true, response_format: "json" }),
        );
        check(
            "get_author book list contains 9942",
            author.structuredContent.books.some((b) => b.book_id === 9942),
            `book_count=${author.structuredContent.book_count}`,
        );

        // ---------------- 10. resolve ----------------
        const resolveRes = await runResolve(
            helper,
            catalog,
            resolveInput.parse({ query: "ابن عثيمين", type: "any", limit: 5, response_format: "json" }),
        );
        check(
            "resolve('ابن عثيمين') returns at least one author",
            resolveRes.structuredContent.authors.length >= 1,
            `n_authors=${resolveRes.structuredContent.authors.length} n_books=${resolveRes.structuredContent.books.length}`,
        );

        // ---------------- 4. search_authors (v2) ----------------
        const sa = await runSearchAuthors(
            helper,
            catalog,
            searchAuthorsInput.parse({ query: "ابن", limit: 5, offset: 0, response_format: "json" }),
        );
        check(
            "search_authors('ابن') >= 1 hit",
            sa.structuredContent.total_hits >= 1,
            `total=${sa.structuredContent.total_hits}`,
        );

        // ---------------- 3. search_books (v2) ----------------
        const sb = await runSearchBooks(
            helper,
            catalog,
            searchBooksInput.parse({ query: "علم", limit: 5, offset: 0, response_format: "json" }),
        );
        check(
            "search_books('علم') >= 1 hit",
            sb.structuredContent.total_hits >= 1,
            `total=${sb.structuredContent.total_hits}`,
        );

        // ---------------- 1. search_pages (v2) ----------------
        const sp = await runSearchPages(
            helper,
            catalog,
            pages,
            searchPagesInput.parse({ query: "الكلام", limit: 20, offset: 0, response_format: "json" }),
        );
        check(
            "search_pages('الكلام') == 9 hits",
            sp.structuredContent.total_hits === 9,
            `total=${sp.structuredContent.total_hits}`,
        );
        const covSizes = {
            by_category: Object.keys(sp.structuredContent.coverage.by_category).length,
            by_century: Object.keys(sp.structuredContent.coverage.by_century).length,
            by_book: Object.keys(sp.structuredContent.coverage.by_book).length,
            by_author: Object.keys(sp.structuredContent.coverage.by_author).length,
        };
        check(
            "search_pages produces non-empty coverage",
            covSizes.by_category + covSizes.by_century + covSizes.by_book + covSizes.by_author > 0,
            `cov=${JSON.stringify(covSizes)}`,
        );
        const firstHit = sp.structuredContent.results[0]!;
        check("search_pages first hit has snippet with mark tag",
            firstHit.snippet_body.includes("<mark>") || firstHit.snippet_foot.includes("<mark>"));

        // ---------------- search_pages with scope (book filter) ----------------
        const spScopedBook = await runSearchPages(
            helper,
            catalog,
            pages,
            searchPagesInput.parse({
                query: "الكلام",
                scope: { book_ids: [9942] },
                limit: 20,
                offset: 0,
                response_format: "json",
            }),
        );
        check(
            "search_pages('الكلام', scope.book_ids=[9942]) == 9 hits",
            spScopedBook.structuredContent.total_hits === 9,
            `total=${spScopedBook.structuredContent.total_hits}`,
        );

        // ---------------- search_pages with author scope ----------------
        const spScopedAuthor = await runSearchPages(
            helper,
            catalog,
            pages,
            searchPagesInput.parse({
                query: "الكلام",
                scope: { author_ids: [authorId] },
                limit: 20,
                offset: 0,
                response_format: "json",
            }),
        );
        check(
            "search_pages('الكلام', scope.author_ids=[uthaymeen]) >= 9 hits",
            spScopedAuthor.structuredContent.total_hits >= 9,
            `total=${spScopedAuthor.structuredContent.total_hits}`,
        );

        // ---------------- search_pages morphology toggle ----------------
        const spMorph = await runSearchPages(
            helper,
            catalog,
            pages,
            searchPagesInput.parse({
                query: "كلم",
                scope: { book_ids: [9942] },
                options: { morphology: true },
                limit: 20,
                offset: 0,
                response_format: "json",
            }),
        );
        check(
            "search_pages('كلم', morphology=true) returns hits via m_body",
            spMorph.structuredContent.total_hits > 0,
            `total=${spMorph.structuredContent.total_hits}`,
        );

        // ---------------- search_pages OPTION_CONFLICT ----------------
        let conflictHit = false;
        let conflictCode = "";
        try {
            await runSearchPages(
                helper,
                catalog,
                pages,
                searchPagesInput.parse({
                    query: "كلم*",
                    options: { morphology: true, wildcards: true },
                    limit: 5,
                    offset: 0,
                    response_format: "json",
                }),
            );
        } catch (e) {
            conflictHit = true;
            conflictCode = String((e as { code?: string }).code ?? "");
        }
        check(
            "search_pages morphology+wildcards → OPTION_CONFLICT",
            conflictHit && conflictCode === "OPTION_CONFLICT",
            `code=${conflictCode}`,
        );

        // ---------------- 2. search_titles ----------------
        const st = await runSearchTitles(
            helper,
            catalog,
            searchTitlesInput.parse({
                query: "الكلام",
                scope: { book_ids: [9942] },
                limit: 10,
                offset: 0,
                response_format: "json",
            }),
        );
        check(
            "search_titles('الكلام', book=9942) >= 1 title hit",
            st.structuredContent.total_hits >= 1,
            `total=${st.structuredContent.total_hits}`,
        );

        // ---------------- 6. get_toc (subtree) ----------------
        const toc = await runGetToc(
            helper,
            catalog,
            pages,
            getTocInput.parse({ book_id: 9942, parent_id: 0, depth: 1, response_format: "json" }),
        );
        check(
            "get_toc(9942, depth=1) returns 23 top-level titles",
            toc.structuredContent.titles.length === 23,
            `n=${toc.structuredContent.titles.length}`,
        );
        const firstTitle = toc.structuredContent.titles[0]!;
        check("first title has non-empty text", firstTitle.title_text.length > 0, firstTitle.title_text);

        // ---------------- 6. get_toc (ancestor chain) ----------------
        const ancestor = await runGetToc(
            helper,
            catalog,
            pages,
            getTocInput.parse({
                book_id: 9942,
                parent_id: 0,
                depth: 1,
                containing_page_id: 17,
                response_format: "json",
            }),
        );
        check(
            "get_toc(9942, containing_page_id=17) returns ancestor chain",
            ancestor.structuredContent.mode === "ancestor_chain" &&
                ancestor.structuredContent.ancestor_chain.length >= 1,
            `n=${ancestor.structuredContent.ancestor_chain.length}`,
        );

        // ---------------- 5. get_page ----------------
        const page17 = await runGetPage(
            helper,
            catalog,
            pages,
            getPageInput.parse({ book_id: 9942, page_id: 17, keep_html: false, response_format: "json" }),
        );
        check(
            "get_page(9942, 17) returns body",
            page17.structuredContent.body.length > 0,
            `body_len=${page17.structuredContent.body.length} printed=${page17.structuredContent.printed_page}`,
        );
        check("get_page has prev/next ids", page17.structuredContent.next_page_id === 18);

        // ---------------- 11. get_pages_range ----------------
        const range = await runGetPagesRange(
            helper,
            catalog,
            pages,
            getPagesRangeInput.parse({
                book_id: 9942,
                start_page_id: 1,
                count: 5,
                keep_html: false,
                response_format: "json",
            }),
        );
        check(
            "get_pages_range(9942, 1, 5) returns 5 pages",
            range.structuredContent.pages.length === 5,
            `n=${range.structuredContent.pages.length}`,
        );
        check(
            "get_pages_range pages have body content",
            range.structuredContent.pages.every((p) => p.body.length > 0),
        );

        // ---------------- 12. get_book_section ----------------
        const firstTitleId = firstTitle.title_id;
        const section = await runGetBookSection(
            helper,
            catalog,
            pages,
            getBookSectionInput.parse({
                book_id: 9942,
                title_id: firstTitleId,
                max_pages: 30,
                keep_html: false,
                response_format: "json",
            }),
        );
        check(
            "get_book_section(9942, first title) returns >=1 page",
            section.structuredContent.pages.length >= 1,
            `n=${section.structuredContent.pages.length} title_text=${section.structuredContent.title_text}`,
        );

        // ---------------- 13. get_citation (shamela) ----------------
        const citShamela = await runGetCitation(
            catalog,
            pages,
            getCitationInput.parse({ book_id: 9942, page_id: 17, style: "shamela", response_format: "json" }),
        );
        check(
            "get_citation(shamela) starts with «الأصول",
            citShamela.structuredContent.formatted.startsWith("«الأصول"),
            citShamela.structuredContent.formatted.slice(0, 60),
        );

        // ---------------- 13. get_citation (full) ----------------
        const citFull = await runGetCitation(
            catalog,
            pages,
            getCitationInput.parse({ book_id: 9942, page_id: 17, style: "full", response_format: "json" }),
        );
        check(
            "get_citation(full) lists missing fields in notes",
            citFull.structuredContent.notes.length >= 1,
            `n_notes=${citFull.structuredContent.notes.length}`,
        );

        // ---------------- 19. get_book_parts ----------------
        const parts = await runGetBookParts(
            catalog,
            pages,
            getBookPartsInput.parse({ book_id: 9942, response_format: "json" }),
        );
        check(
            "get_book_parts(9942) is single-volume",
            parts.structuredContent.is_multi_volume === false,
            `n_parts=${parts.structuredContent.parts.length}`,
        );
        check("get_book_parts(9942) total_pages > 0", parts.structuredContent.total_pages > 0,
            `total=${parts.structuredContent.total_pages}`);

        // ---------------- 20. get_page_services ----------------
        const psvc = await runGetPageServices(
            catalog,
            pages,
            getPageServicesInput.parse({ book_id: 9942, page_id: 17, response_format: "json" }),
        );
        check(
            "get_page_services(9942, 17) has_services=false",
            psvc.structuredContent.has_services === false,
        );

        // ---------------- 14. search_quran ----------------
        const sq = await runSearchQuran(
            helper,
            searchQuranInput.parse({ query: "الرحمن", limit: 5, offset: 0, response_format: "json" }),
        );
        check(
            "search_quran('الرحمن') >= 1 hit",
            sq.structuredContent.total_hits >= 1,
            `total=${sq.structuredContent.total_hits}`,
        );

        // ---------------- 15. get_aya ----------------
        const aya1 = await runGetAya(helper, getAyaInput.parse({ aya_id: 1, response_format: "json" }));
        const ayaJoined = `${aya1.structuredContent.body ?? ""}|${aya1.structuredContent.amiri ?? ""}|${aya1.structuredContent.majma ?? ""}`;
        check(
            "get_aya(1) is basmala",
            ayaJoined.includes("بِسْمِ") || ayaJoined.includes("بسم"),
            `body=${(aya1.structuredContent.body ?? "").slice(0, 60)}`,
        );

        const ayaSurahAya = await runGetAya(
            helper,
            getAyaInput.parse({ surah: 1, aya: 1, response_format: "json" }),
        );
        check(
            "get_aya(surah=1, aya=1) == aya_id 1",
            ayaSurahAya.structuredContent.aya_id === 1,
        );

        // ---------------- 16. get_tafseer_of_aya ----------------
        let tafseerCode = "";
        let tafseerOk = false;
        let tafseerCount = -1;
        try {
            const tf = await runGetTafseerOfAya(
                catalog,
                services,
                getTafseerOfAyaInput.parse({ aya_id: 1, downloaded_only: false, response_format: "json" }),
            );
            tafseerOk = true;
            tafseerCount = tf.structuredContent.total;
        } catch (e) {
            tafseerCode = String((e as { code?: string }).code ?? "");
        }
        // tafseer.db may or may not have entries for aya_id=1 depending on the install — both are acceptable.
        check(
            "get_tafseer_of_aya(1) either returns hits or a clean SERVICE_KEY_NOT_FOUND",
            tafseerOk || tafseerCode === "SERVICE_KEY_NOT_FOUND",
            tafseerOk ? `total=${tafseerCount}` : `code=${tafseerCode}`,
        );

        // ---------------- 17. get_books_for_hadith ----------------
        let hadithOk = false;
        let hadithCode = "";
        try {
            await runGetBooksForHadith(
                catalog,
                services,
                getBooksForHadithInput.parse({ hadith_key: 1, downloaded_only: false, response_format: "json" }),
            );
            hadithOk = true;
        } catch (e) {
            hadithCode = String((e as { code?: string }).code ?? "");
        }
        check(
            "get_books_for_hadith(1) either returns hits or a clean SERVICE_KEY_NOT_FOUND",
            hadithOk || hadithCode === "SERVICE_KEY_NOT_FOUND",
            hadithOk ? "ok" : `code=${hadithCode}`,
        );

        // ---------------- markdown rendering smoke ----------------
        const cats_md = runListCategories(catalog, listCategoriesInput.parse({ include_counts: true, response_format: "markdown" }));
        check(
            "markdown render produces text",
            cats_md.content[0]!.type === "text" && cats_md.content[0]!.text.startsWith("#"),
        );

        // ---------------- pagination has_more ----------------
        const sa_paged = await runSearchAuthors(
            helper,
            catalog,
            searchAuthorsInput.parse({ query: "ابن", limit: 5, offset: 0, response_format: "json" }),
        );
        check(
            "search_authors pagination has_more=true (lots of hits)",
            sa_paged.structuredContent.has_more === true && sa_paged.structuredContent.next_offset === 5,
            `next_offset=${sa_paged.structuredContent.next_offset}`,
        );
    } catch (err) {
        failures.push(`uncaught: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
    } finally {
        await helper.close();
        pages.close();
        services.close();
    }

    console.log();
    console.log(`assertions run: ${assertionsRun}`);
    if (failures.length === 0) {
        console.log("ALL PASS");
        return 0;
    }
    console.log(`FAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error("smoke crashed:", err);
        process.exit(1);
    });

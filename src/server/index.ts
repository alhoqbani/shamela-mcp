/**
 * shamela-mcp — MCP server entry point.
 *
 * Spins up a Java helper subprocess on first tool call, exposes 20 tools
 * via `registerTool`, returns dual content (markdown text + structuredContent).
 * All tool handlers wrap their backing implementations in a shared error
 * envelope that maps ShamelaError / HelperError / ShamelaNotFoundError to
 * MCP `isError: true` content.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Catalog } from "./catalog.js";
import { VERSION } from "./constants.js";
import { errorCode, formatErrorMessage } from "./errors.js";
import { Helper } from "./helper.js";
import { PageStore } from "./pages.js";
import { resolveAll } from "./paths.js";
import { ServiceStore } from "./services.js";

import {
    getAuthorInputShape,
    runGetAuthor,
    type GetAuthorOutput,
} from "./tools/getAuthor.js";
import { getAyaInputShape, runGetAya, type GetAyaOutput } from "./tools/getAya.js";
import {
    getBookInputShape,
    runGetBook,
    type GetBookOutput,
} from "./tools/getBook.js";
import {
    getBookPartsInputShape,
    runGetBookParts,
    type GetBookPartsOutput,
} from "./tools/getBookParts.js";
import {
    getBookSectionInputShape,
    runGetBookSection,
    type GetBookSectionOutput,
} from "./tools/getBookSection.js";
import {
    getBooksForHadithInputShape,
    runGetBooksForHadith,
    type GetBooksForHadithOutput,
} from "./tools/getBooksForHadith.js";
import {
    getCitationInputShape,
    runGetCitation,
    type GetCitationOutput,
} from "./tools/getCitation.js";
import { getPageInputShape, runGetPage, type GetPageOutput } from "./tools/getPage.js";
import {
    getPageServicesInputShape,
    runGetPageServices,
    type GetPageServicesOutput,
} from "./tools/getPageServices.js";
import {
    getPagesRangeInputShape,
    runGetPagesRange,
    type GetPagesRangeOutput,
} from "./tools/getPagesRange.js";
import {
    getTafseerOfAyaInputShape,
    runGetTafseerOfAya,
    type GetTafseerOfAyaOutput,
} from "./tools/getTafseerOfAya.js";
import { getTocInputShape, runGetToc, type GetTocOutput } from "./tools/getToc.js";
import {
    listCategoriesInputShape,
    runListCategories,
    type ListCategoriesOutput,
} from "./tools/listCategories.js";
import {
    listDownloadedBooksInputShape,
    runListDownloadedBooks,
    type ListDownloadedBooksOutput,
} from "./tools/listDownloadedBooks.js";
import { resolveInputShape, runResolve, type ResolveOutput } from "./tools/resolve.js";
import {
    searchAuthorsInputShape,
    runSearchAuthors,
    type SearchAuthorsOutput,
} from "./tools/searchAuthors.js";
import {
    searchBooksInputShape,
    runSearchBooks,
    type SearchBooksOutput,
} from "./tools/searchBooks.js";
import {
    searchPagesInputShape,
    runSearchPages,
    type SearchPagesOutput,
} from "./tools/searchPages.js";
import {
    searchQuranInputShape,
    runSearchQuran,
    type SearchQuranOutput,
} from "./tools/searchQuran.js";
import {
    searchTitlesInputShape,
    runSearchTitles,
    type SearchTitlesOutput,
} from "./tools/searchTitles.js";

// @ts-expect-error — esbuild `--loader:.wasm=binary` inlines this as a Uint8Array.
import sqlWasm from "sql.js/dist/sql-wasm.wasm";

const SQL_WASM_BINARY: Uint8Array = sqlWasm as unknown as Uint8Array;

function logInfo(msg: string): void {
    process.stderr.write(`[shamela-mcp] ${msg}\n`);
}

interface Backend {
    helper: Helper;
    catalog: Catalog;
    pages: PageStore;
    services: ServiceStore;
}

const COMMON_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;

type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

function wrapErr(err: unknown): ToolResult {
    return {
        isError: true,
        content: [
            {
                type: "text",
                text: `${errorCode(err)}: ${formatErrorMessage(err)}`,
            },
        ],
    };
}

async function main(): Promise<void> {
    let backend: Backend | null = null;

    const getBackend = async (): Promise<Backend> => {
        if (backend) return backend;
        const paths = await resolveAll();
        logInfo(`install root: ${paths.installRoot}`);
        logInfo(`jre:          ${paths.jre}`);
        logInfo(`jars:         ${paths.jars.length} files`);
        logInfo(`helper jar:   ${paths.helperJar}`);

        const masterDb = (await import("node:path")).join(paths.database, "master.db");
        const catalog = await Catalog.load(masterDb, SQL_WASM_BINARY);
        logInfo(
            `catalog:      ${catalog.bookCount()} books, ${catalog.authorCount()} authors, ${catalog.categoryCount()} categories`,
        );
        const pages = new PageStore(paths.database, SQL_WASM_BINARY);
        const services = new ServiceStore(paths.database, SQL_WASM_BINARY);

        const h = new Helper({ paths });
        await h.ready(20_000);
        backend = { helper: h, catalog, pages, services };
        return backend;
    };

    const server = new McpServer(
        { name: "shamela", version: VERSION },
        { capabilities: { tools: {} } },
    );

    // ----------- 1. shamela_search_pages -----------
    server.registerTool(
        "shamela_search_pages",
        {
            title: "بحث في صفحات الكتب",
            description:
                "Search the body (matn) and footnotes (الحواشي) of every Shamela page the user has downloaded locally. AND-combines tokens; each token can match in any of the search_in fields. Default scope is the full downloaded library; pass `scope` (book_ids/author_ids/category_ids/period_*/downloaded_only) to narrow. `options` controls morphology (Arabic root expansion via AlKhalil), wildcards (`*`/`?` per token, cannot combine with morphology), and search_in subset (body/foot/comment). Returns total_hits + paginated results with book name, author, printed-page label, and a snippet with <mark>...</mark> around matches; coverage rolls up by category/century/book/author. preserve_diacritics/_hamza/_digits currently return OPTION_NOT_SUPPORTED. Use `shamela_search_titles` for chapter title search instead. Examples: shamela_search_pages({query:'الكلام'}), shamela_search_pages({query:'استصناع', scope:{category_ids:[17]}}), shamela_search_pages({query:'كلم', options:{morphology:true}}).",
            inputSchema: searchPagesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchPages(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchPages>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 2. shamela_search_titles -----------
    server.registerTool(
        "shamela_search_titles",
        {
            title: "بحث في عناوين الفصول",
            description:
                "Search Shamela's title/ Lucene index for chapter and section titles. Same query/scope/options/pagination shape as shamela_search_pages but matches title text rather than page bodies. After finding a matching title, use shamela_get_book_section(book_id, title_id) to read the full section. Examples: shamela_search_titles({query:'باب الصيام'}), shamela_search_titles({query:'تعريف', scope:{book_ids:[9942]}}).",
            inputSchema: searchTitlesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchTitles(b.helper, b.catalog, args as Parameters<typeof runSearchTitles>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 3. shamela_search_books -----------
    server.registerTool(
        "shamela_search_books",
        {
            title: "بحث في فهرس الكتب",
            description:
                "Search Shamela's catalog of ~8,500 books by name, author, or bibliography text. Pre-built index — works even before any books are downloaded. scope.book_ids is not accepted (the catalog IS the universe); use scope.author_ids, category_ids, period_*, downloaded_only. Returns paginated results with book name, author, category, book_date, downloaded flag, and a snippet from the bibliography. Examples: shamela_search_books({query:'الأصول'}), shamela_search_books({query:'فقه', scope:{category_ids:[17], downloaded_only:true}}).",
            inputSchema: searchBooksInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchBooks(b.helper, b.catalog, args as Parameters<typeof runSearchBooks>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 4. shamela_search_authors -----------
    server.registerTool(
        "shamela_search_authors",
        {
            title: "بحث في فهرس المؤلفين",
            description:
                "Search Shamela's ~3,200-author catalog by name or biography text. Pre-built index — no downloads needed. No scope (authors aren't scoped by category/period). Returns author name, Hijri death year, and book count. Use the resulting author_id with shamela_get_author for full details, or with scope.author_ids in shamela_search_pages/_books to filter by that author. Examples: shamela_search_authors({query:'ابن عثيمين'}), shamela_search_authors({query:'الشافعي', options:{wildcards:false}}).",
            inputSchema: searchAuthorsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchAuthors(b.helper, b.catalog, args as Parameters<typeof runSearchAuthors>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 5. shamela_get_page -----------
    server.registerTool(
        "shamela_get_page",
        {
            title: "جلب صفحة",
            description:
                "Fetch the full text of one Shamela page (book_id, page_id). Returns body (matn), foot (footnotes), comment (user notes), printed_page label, prev/next page ids, the chapter ancestor chain (root → leaf), and the category path. Set keep_html=true to preserve inline <span data-type='title'> markers; default strips them. The book must be downloaded (BOOK_NOT_DOWNLOADED otherwise). For batch reads use shamela_get_pages_range; for full chapters use shamela_get_book_section.",
            inputSchema: getPageInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetPage(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetPage>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 6. shamela_get_toc -----------
    server.registerTool(
        "shamela_get_toc",
        {
            title: "جلب فهرس الكتاب",
            description:
                "Fetch a downloaded book's table of contents. Two modes: (a) subtree mode (default) — pass parent_id (0 = top level) and depth (1–5) to get a tree of titles; (b) ancestor-chain mode — pass containing_page_id to get the root → leaf chapter chain that contains that page. Returns title_id, title_text, page_id, has_children for each entry. Use the title_id with shamela_get_book_section to read the section. Examples: shamela_get_toc({book_id:9942, depth:1}) returns 23 top-level chapters of book 9942; shamela_get_toc({book_id:9942, containing_page_id:17}) returns the chapter containing page 17.",
            inputSchema: getTocInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetToc(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetToc>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 7. shamela_get_book -----------
    server.registerTool(
        "shamela_get_book",
        {
            title: "جلب بيانات كتاب",
            description:
                "Fetch full metadata for a book by book_id. Returns book_name, all authors (main + co), category, book_type (printed/manuscript/journal/thesis/electronic/audio), book_date (Hijri composition year), printed flag, downloaded flag, publication_date (DDMMYYYY Hijri from meta_data), sub_books, and a `notes` array listing citation-grade fields master.db doesn't have (edition/publisher/city/editor — never fabricate these). Examples: shamela_get_book({book_id:9942}) returns metadata for «الأصول من علم الأصول».",
            inputSchema: getBookInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = runGetBook(b.catalog, args as Parameters<typeof runGetBook>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 8. shamela_get_author -----------
    server.registerTool(
        "shamela_get_author",
        {
            title: "جلب بيانات مؤلف",
            description:
                "Fetch metadata for an author by author_id, optionally with the list of books they authored. Returns author_name, death_year (null if unknown or modern), death_text (display string), and the book list (main + co-authored). Each book entry has book_id, book_name, book_date, downloaded flag. Use include_books=false to skip the book list when you only need name/death year. Example: shamela_get_author({author_id:57}) returns Ibn Uthaymeen + his books.",
            inputSchema: getAuthorInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = runGetAuthor(b.catalog, args as Parameters<typeof runGetAuthor>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 9. shamela_list_categories -----------
    server.registerTool(
        "shamela_list_categories",
        {
            title: "قائمة التصنيفات",
            description:
                "List all 41 categories in Shamela's catalog. Categories are flat (no parent_id, no transitive expansion). Each entry has category_id, category_name, and book_count (total books in catalog under that category). Use category_id values with scope.category_ids in search_pages / search_books to narrow searches. Set include_counts=false to skip the book counts (slightly faster but counts are cached so cost is negligible).",
            inputSchema: listCategoriesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = runListCategories(b.catalog, args as Parameters<typeof runListCategories>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 10. shamela_resolve -----------
    server.registerTool(
        "shamela_resolve",
        {
            title: "تحويل اسم إلى معرِّف",
            description:
                "Disambiguate Arabic name fragments to book_ids and/or author_ids. Uses the pre-built s_book/ + s_author/ n-gram indexes for fast partial matching. type='book' searches only books, 'author' only authors, 'any' (default) both. Returns up to `limit` results per type with confidence scores. Use this BEFORE search_pages / search_books / search_authors when the user mentions a name but doesn't know the exact ID. Examples: shamela_resolve({query:'ابن عثيمين'}) → returns author_id=57; shamela_resolve({query:'الأصول من علم'}) → returns book matches.",
            inputSchema: resolveInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runResolve(b.helper, b.catalog, args as Parameters<typeof runResolve>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 11. shamela_get_pages_range -----------
    server.registerTool(
        "shamela_get_pages_range",
        {
            title: "جلب نطاق صفحات",
            description:
                "Fetch N (1–20, default 5) consecutive pages from a downloaded book starting at start_page_id. Faster than calling shamela_get_page in a loop. Each page entry has page_id, printed_page, part, body, foot, comment. has_more flag indicates whether more pages exist after the returned range. For full chapters use shamela_get_book_section instead — it knows where the chapter ends. Example: shamela_get_pages_range({book_id:9942, start_page_id:1, count:5}).",
            inputSchema: getPagesRangeInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetPagesRange(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetPagesRange>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 12. shamela_get_book_section -----------
    server.registerTool(
        "shamela_get_book_section",
        {
            title: "جلب باب من كتاب",
            description:
                "Fetch every page under a chapter title. Resolves the chapter's start/end page range from the per-book SQLite (next-sibling-title boundary), then batch-reads the page contents. Capped at max_pages (default 30, max 100); sets `truncated:true` if the section is longer. Use shamela_get_toc to find title_ids, then this tool to read the matching section. Example: shamela_get_book_section({book_id:9942, title_id:11}) reads the full chapter starting at title 11.",
            inputSchema: getBookSectionInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetBookSection(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetBookSection>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 13. shamela_get_citation -----------
    server.registerTool(
        "shamela_get_citation",
        {
            title: "صياغة إحالة",
            description:
                "Format a citation in three styles. style='shamela' (default) replicates Shamela's UI copy-with-citation: «<book>» (<part>/ <page>):\\n«<text>». style='short' is a one-line inline reference: <author>، <book>، ص <page>. style='full' is the long form with author death year and book composition year, plus a `notes[]` array listing missing citation-grade fields (edition/publisher/city/editor — master.db doesn't have these; never fabricate). All numbers in output use Arabic-Indic digits. Examples: shamela_get_citation({book_id:9942, page_id:17, style:'shamela'}), shamela_get_citation({book_id:9942, page_id:17, text:'الكلام تعريفه...', style:'shamela'}).",
            inputSchema: getCitationInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetCitation(b.catalog, b.pages, args as Parameters<typeof runGetCitation>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 14. shamela_search_quran -----------
    server.registerTool(
        "shamela_search_quran",
        {
            title: "بحث في القرآن",
            description:
                "Search the Qur'an (6,236 verses, Hafs from Asim, Egyptian إملائي orthography) via the pre-built aya/ Lucene index. Ships zero-config — works on a fresh Shamela install. Returns aya_id (1..6236), surah, surah_name, aya, body (full verse text), and a snippet with <mark>...</mark> around matches. Pair with shamela_get_aya to fetch a single verse with the Othmani Amiri rendering, or with shamela_get_tafseer_of_aya to find tafsir books that comment on a matching verse.",
            inputSchema: searchQuranInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchQuran(b.helper, args as Parameters<typeof runSearchQuran>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 15. shamela_get_aya -----------
    server.registerTool(
        "shamela_get_aya",
        {
            title: "جلب آية",
            description:
                "Fetch a single Qur'anic verse by aya_id (1..6236, cumulative across surahs) OR by surah (1..114) + aya (1..N). Returns the verse text in three renderings: body (Egyptian إملائي, Hafs from Asim — the searchable form), amiri (Othmani Amiri rendering for display), majma (KFQPC Mushaf rendering). Pass either aya_id alone OR both surah and aya. Examples: shamela_get_aya({aya_id:1}) → al-Fatiha verse 1 (basmala); shamela_get_aya({surah:55, aya:1}) → Ar-Rahman verse 1.",
            inputSchema: getAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetAya(b.helper, args as Parameters<typeof runGetAya>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 16. shamela_get_tafseer_of_aya -----------
    server.registerTool(
        "shamela_get_tafseer_of_aya",
        {
            title: "تفاسير آية",
            description:
                "Given a Qur'anic verse, list every tafsir book in the catalog that has a page commenting on it. Uses Shamela's pre-built service/tafseer.db join. Pass either aya_id (1..6236) OR surah+aya. By default returns only books the user has downloaded locally (downloaded_only=true) — set to false to see the full catalog of tafsirs that COULD comment on this verse if downloaded. Each result has book_id, book_name, author_name, page_id, downloaded flag. Pair with shamela_get_page(book_id, page_id) to read the actual tafsir text.",
            inputSchema: getTafseerOfAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetTafseerOfAya(b.catalog, b.services, args as Parameters<typeof runGetTafseerOfAya>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 17. shamela_get_books_for_hadith -----------
    server.registerTool(
        "shamela_get_books_for_hadith",
        {
            title: "كتب تتضمَّن حديثًا",
            description:
                "Given a Shamela hadith key (numeric identifier shared by all collections that record the same hadith), list every book that cites it. Uses Shamela's pre-built service/hadeeth.db join. By default filters to downloaded books only. Each result has book_id, book_name, author_name, page_id, downloaded flag. Pair with shamela_get_page to read the cited page. Useful for cross-collection hadith research (Bukhari + Muslim + Sunan + Musnad references for the same hadith).",
            inputSchema: getBooksForHadithInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetBooksForHadith(b.catalog, b.services, args as Parameters<typeof runGetBooksForHadith>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 18. shamela_list_downloaded_books -----------
    server.registerTool(
        "shamela_list_downloaded_books",
        {
            title: "قائمة الكتب المنزَّلة",
            description:
                "List the books actually downloaded on this user's machine (master.db.book.major_ondisk > 0). Returns book_id, book_name, author_name, category, book_date for each. Crucial for honest research scoping: shamela_search_pages only returns hits from downloaded books, so this tool tells the LLM what's actually searchable. Paginated via limit/offset. Example: shamela_list_downloaded_books({limit:50}) → all downloaded books on this install.",
            inputSchema: listDownloadedBooksInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = runListDownloadedBooks(b.catalog, args as Parameters<typeof runListDownloadedBooks>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 19. shamela_get_book_parts -----------
    server.registerTool(
        "shamela_get_book_parts",
        {
            title: "أجزاء الكتاب",
            description:
                "List the volumes/parts of a multi-volume book. Returns is_multi_volume flag, total_pages, and an array of parts each with part name (e.g. 'ج 1'), page_count, first_page_id, last_page_id. For single-volume books returns is_multi_volume:false and an empty parts array. Useful to know whether a citation needs a part designator. Example: shamela_get_book_parts({book_id:9942}) → single-volume, no parts (is_multi_volume:false).",
            inputSchema: getBookPartsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetBookParts(b.catalog, b.pages, args as Parameters<typeof runGetBookParts>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 20. shamela_get_page_services -----------
    server.registerTool(
        "shamela_get_page_services",
        {
            title: "إشارات الصفحة",
            description:
                "Read the per-page services annotations (Qur'anic verses cited, hadith keys, isnād chains) for a specific (book_id, page_id). Returns has_services flag plus three arrays: ayat (cumulative aya_ids), hadeeth (hadith keys), esnad (chain strings). Many books — particularly non-hadith works like our test book 9942 — have no services. Useful to pivot from a search hit to the Qur'anic/hadith content it discusses: pair the returned aya_ids with shamela_get_aya, or hadith keys with shamela_get_books_for_hadith.",
            inputSchema: getPageServicesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetPageServices(b.catalog, b.pages, args as Parameters<typeof runGetPageServices>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo(`shamela-mcp v${VERSION} ready (20 tools registered)`);

    const shutdown = () => {
        backend?.helper.close();
        backend?.pages.close();
        backend?.services.close();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    void z;
}

main().catch((err) => {
    process.stderr.write(`[shamela-mcp] fatal: ${formatErrorMessage(err)}\n`);
    process.exit(1);
});

// Type re-exports for the smoke test.
export type {
    GetAuthorOutput,
    GetAyaOutput,
    GetBookOutput,
    GetBookPartsOutput,
    GetBookSectionOutput,
    GetBooksForHadithOutput,
    GetCitationOutput,
    GetPageOutput,
    GetPageServicesOutput,
    GetPagesRangeOutput,
    GetTafseerOfAyaOutput,
    GetTocOutput,
    ListCategoriesOutput,
    ListDownloadedBooksOutput,
    ResolveOutput,
    SearchAuthorsOutput,
    SearchBooksOutput,
    SearchPagesOutput,
    SearchQuranOutput,
    SearchTitlesOutput,
};

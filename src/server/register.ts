/**
 * The tool surface: the 34 tools and 5 resources, registered on an MCP server.
 *
 * This module knows nothing about where the server is running. It takes a
 * `BackendProvider` — see `backend.ts` — and hands its parts to the tool
 * implementations under `tools/`. The desktop extension and a remote host both
 * arrive here through `registerAllTools`, so there is one registration list,
 * one set of descriptions, and one wire format for every consumer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
    createBackendProvider,
    type Backend,
    type BackendProvider,
    type PartialBackend,
    type ShamelaDeps,
} from "./backend.js";
import { VERSION } from "./constants.js";
import { errorCode, formatErrorMessage } from "./errors.js";
import { buildGuideText } from "./guide.js";
import { withNeutralSchemas } from "./schemaCompat.js";

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
    listCategoriesInput,
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
import {
    searchPhraseInputShape,
    runSearchPhrase,
    type SearchPhraseOutput,
} from "./tools/searchPhrase.js";
import {
    searchHadithInputShape,
    runSearchHadith,
    type SearchHadithOutput,
} from "./tools/searchHadith.js";
import { healthInput, healthInputShape, runHealth, type HealthOutput } from "./tools/health.js";
import { AyaIndexStore } from "./ayaIndex/store.js";
import { messages } from "./i18n/index.js";
import { OUTPUT_SCHEMAS } from "./outputSchemas.js";
import { runSuggestDownload, suggestDownloadInputShape } from "./tools/suggestDownload.js";
import { runVerifyQuote, verifyQuoteInputShape, type VerifyQuoteOutput } from "./tools/verifyQuote.js";
import { runScanConsensus, scanConsensusInputShape, type ScanConsensusOutput } from "./tools/scanConsensus.js";
import { runResearchScope, researchScopeInputShape, type ResearchScopeOutput } from "./tools/researchScope.js";
import { searchExactInputShape, runSearchExact, type SearchExactOutput } from "./tools/searchExact.js";
import { searchBooleanInputShape, runSearchBoolean, type SearchBooleanOutput } from "./tools/searchBoolean.js";
import { rootStatsInputShape, runRootStats, type RootStatsOutput } from "./tools/rootStats.js";
import { booksByPeriodInputShape, runBooksByPeriod, type BooksByPeriodOutput } from "./tools/booksByPeriod.js";
import {
    listTafsirsForAyaInputShape,
    runListTafsirsForAya,
    type ListTafsirsForAyaOutput,
} from "./tools/listTafsirsForAya.js";
import {
    getTafseerTextsInputShape,
    runGetTafseerTexts,
    type GetTafseerTextsOutput,
} from "./tools/getTafseerTexts.js";
import { guideInputShape, runGuide, type GuideOutput } from "./tools/guide.js";

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

function registerTools(server: McpServer, provider: BackendProvider): McpServer {
    // One catalogue for the whole server: the language is settled before any
    // tool is registered, and cannot change while the process runs.
    const L = messages();

    // Whatever transport this server is given, its schemas go out without a
    // dialect declaration — see schemaCompat.ts for the client that refused
    // them otherwise. Hooked here rather than in the entry point so the tests'
    // in-memory transport exercises the same wire the real client sees, and so
    // a host that brings its own server gets the same wire without knowing it
    // had to ask.
    const originalConnect = server.connect.bind(server);
    server.connect = (transport) => originalConnect(withNeutralSchemas(transport));

    // ----------- 1. shamela_search_pages -----------
    server.registerTool(
        "shamela_search_pages",
        {
            title: L.toolTitles.shamela_search_pages,
            description:
                "Search the body (matn) and footnotes (الحواشي) of every Shamela page the user has downloaded locally. AND-combines tokens; each token can match in any of the search_in fields. Default scope is the full downloaded library; pass `scope` (book_ids/author_ids/category_ids/period_*/downloaded_only) to narrow. `options` controls morphology (Arabic root expansion via AlKhalil), wildcards (`*`/`?` per token, cannot combine with morphology), and search_in subset (body/foot/comment). Returns total_hits + paginated results with book name, author, printed-page label, and a snippet with <mark>...</mark> around matches; coverage rolls up by category/century/book/author and says how much of the search it speaks for: `coverage.basis` is 'all_results' when every match was counted or 'window' when only the fetched page was, `coverage.total_counted` is how many hits went into the buckets, and `coverage.capped`=true means counting stopped at 5,000 so the bucket counts are floors. preserve_diacritics/_hamza/_digits currently return OPTION_NOT_SUPPORTED. Use `shamela_search_titles` for chapter title search instead. Examples: shamela_search_pages({query:'الكلام'}), shamela_search_pages({query:'استصناع', scope:{category_ids:[17]}}), shamela_search_pages({query:'كلم', options:{morphology:true}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_pages"] as never,
            inputSchema: searchPagesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchPages(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchPages>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 2. shamela_search_titles -----------
    server.registerTool(
        "shamela_search_titles",
        {
            title: L.toolTitles.shamela_search_titles,
            description:
                "Search Shamela's title/ Lucene index for chapter and section titles. Same query/scope/options/pagination shape as shamela_search_pages but matches title text rather than page bodies. After finding a matching title, use shamela_get_book_section(book_id, title_id) to read the full section. Examples: shamela_search_titles({query:'باب الصيام'}), shamela_search_titles({query:'تعريف', scope:{book_ids:[<id from shamela_resolve or shamela_list_downloaded_books>]}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_titles"] as never,
            inputSchema: searchTitlesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchTitles(b.helper, b.catalog, args as Parameters<typeof runSearchTitles>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 3. shamela_search_books -----------
    server.registerTool(
        "shamela_search_books",
        {
            title: L.toolTitles.shamela_search_books,
            description:
                "Search Shamela's catalog of ~8,500 books by name, author, or bibliography text. Pre-built index — works even before any books are downloaded. scope.book_ids is not accepted (the catalog IS the universe); use scope.author_ids, category_ids, period_*, downloaded_only. Returns paginated results with book name, author, category, book_date, downloaded flag, and a snippet from the bibliography. Examples: shamela_search_books({query:'الأصول'}), shamela_search_books({query:'فقه', scope:{category_ids:[17], downloaded_only:true}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_books"] as never,
            inputSchema: searchBooksInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchBooks(b.helper, b.catalog, args as Parameters<typeof runSearchBooks>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 4. shamela_search_authors -----------
    server.registerTool(
        "shamela_search_authors",
        {
            title: L.toolTitles.shamela_search_authors,
            description:
                "Search Shamela's ~3,200-author catalog by name or biography text. Pre-built index — no downloads needed. No scope (authors aren't scoped by category/period). Returns author name, Hijri death year, and book count. This searches BIOGRAPHIES as well as names, so a query can match scholars who merely mention the one you meant. Results are re-ranked so that an author whose NAME matches leads, but when you want the id of one specific named scholar, shamela_resolve is the tool built for it and returns a confidence score. Arabic scholars go by several name forms — when a query genuinely returns nothing, try the kunya, nisba, and shuhra variants before concluding absence (جرّب الكنية والنسبة والشهرة: ابن قدامة / الموفق / المقدسي). Use the resulting author_id with shamela_get_author for full details, or with scope.author_ids in shamela_search_pages/_books to filter by that author — check the name before you scope a whole search to it. Examples: shamela_search_authors({query:'ابن قدامة'}), shamela_search_authors({query:'الشافعي', options:{wildcards:false}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_authors"] as never,
            inputSchema: searchAuthorsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchAuthors(b.helper, b.catalog, args as Parameters<typeof runSearchAuthors>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 5. shamela_get_page -----------
    server.registerTool(
        "shamela_get_page",
        {
            title: L.toolTitles.shamela_get_page,
            description:
                "Fetch the full text of one Shamela page (book_id, page_id). Returns body (matn), foot (footnotes), comment (user notes), printed_page label, prev/next page ids, the chapter ancestor chain (root → leaf), and the category path. Set keep_html=true to preserve inline <span data-type='title'> markers; default strips them. The book must be downloaded (BOOK_NOT_DOWNLOADED otherwise). For batch reads use shamela_get_pages_range; for full chapters use shamela_get_book_section. Long pages: the body is split into parts of ~4000 chars — `body_part` selects the 1-based part, and body_total_parts/body_has_more report the split (footnote/comment come with part 1; a `_display` hint advises when to ask the user how to show it).",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_page"] as never,
            inputSchema: getPageInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetPage(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetPage>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 6. shamela_get_toc -----------
    server.registerTool(
        "shamela_get_toc",
        {
            title: L.toolTitles.shamela_get_toc,
            description:
                "Fetch a downloaded book's table of contents. Two modes: (a) subtree mode (default) — pass parent_id (0 = top level) and depth (1–5) to get a tree of titles; (b) ancestor-chain mode — pass containing_page_id to get the root → leaf chapter chain that contains that page. Returns title_id, title_text, page_id, has_children for each entry. Use the title_id with shamela_get_book_section to read the section. Examples: shamela_get_toc({book_id:<id>, depth:1}) lists top-level chapters; shamela_get_toc({book_id:<id>, containing_page_id:17}) returns the chapter containing page 17. Find downloaded book ids via shamela_list_downloaded_books or shamela_resolve.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_toc"] as never,
            inputSchema: getTocInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetToc(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetToc>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 7. shamela_get_book -----------
    server.registerTool(
        "shamela_get_book",
        {
            title: L.toolTitles.shamela_get_book,
            description:
                "Fetch full metadata for a book by book_id. Returns book_name, all authors (main + co), category, book_type (printed/manuscript/journal/thesis/electronic/audio), book_date (Shamela's DATING year for the work — not the year it was written: it tracks the original author's death and equals the main author's death year for 8,467 of 8,593 catalogue books), printed flag, downloaded flag (true ONLY when both master.db says so AND the per-book SQLite has page rows), publication_date (Shamela's own ddMMyyyy Hijri stamp for when the catalogue ENTRY was added or refreshed — NOT the print date of the edition; over half the library shares one seed value), sub_books, and a `notes` array listing citation-grade fields master.db doesn't have (edition/publisher/city/editor — never fabricate these). Find ids via shamela_resolve('book name') or shamela_list_downloaded_books. Works on any catalog book whether downloaded or not.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_book"] as never,
            inputSchema: getBookInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetBook(b.catalog, b.pages, b.helper, args as Parameters<typeof runGetBook>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 8. shamela_get_author -----------
    server.registerTool(
        "shamela_get_author",
        {
            title: L.toolTitles.shamela_get_author,
            description:
                "Fetch metadata for an author by author_id, optionally with the list of books they authored. Returns author_name, death_year (null if unknown or modern), death_text (display string), and the book list (main + co-authored). Each book entry has book_id, book_name, book_date, downloaded flag. Use include_books=false to skip the book list when you only need name/death year. Example: shamela_get_author({author_id:57}) returns Ibn Uthaymeen + his books.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_author"] as never,
            inputSchema: getAuthorInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = runGetAuthor(b.catalog, args as Parameters<typeof runGetAuthor>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 9. shamela_list_categories -----------
    server.registerTool(
        "shamela_list_categories",
        {
            title: L.toolTitles.shamela_list_categories,
            description:
                "List all 41 categories in Shamela's catalog. Categories are flat (no parent_id, no transitive expansion). Each entry has category_id, category_name, and book_count (total books in catalog under that category). Use category_id values with scope.category_ids in search_pages / search_books to narrow searches. Set include_counts=false to skip the book counts (slightly faster but counts are cached so cost is negligible). Each entry also reports downloaded_count (books in that category present on THIS machine), and downloaded_only=true lists only categories where the user has downloads — useful because Shamela is a 41-category library and tafsir alone spans categories 3 (التفسير), 4 (علوم القرآن وأصول التفسير), and 5 (التجويد والقراءات).",
            outputSchema: OUTPUT_SCHEMAS["shamela_list_categories"] as never,
            inputSchema: listCategoriesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = runListCategories(b.catalog, args as Parameters<typeof runListCategories>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 10. shamela_resolve -----------
    server.registerTool(
        "shamela_resolve",
        {
            title: L.toolTitles.shamela_resolve,
            description:
                "Disambiguate a name fragment to book_ids and/or author_ids. Uses the pre-built s_book/ + s_author/ n-gram indexes for fast partial matching. type='book' searches only books, 'author' only authors, 'any' (default) both. Returns up to `limit` results per type with confidence scores. Use this BEFORE search_pages / search_books / search_authors when the user mentions a name but doesn't know the exact ID. A name written in LATIN letters is also accepted: when the Arabic indexes return nothing, the spelling is matched against the catalogue's own Arabic names ('Ibn Qudama', 'al-Mughni', 'Sahih Muslim'), and the response carries transliterated:true — those are candidates to confirm, not index hits, so check the Arabic name before scoping a search to one. Examples: shamela_resolve({query:'ابن قدامة'}) → returns the matching author_id(s) with confidence; shamela_resolve({query:'روضة الناظر'}) → returns book matches; shamela_resolve({query:'Ibn Qudama'}) → the same author, reached by spelling.",
            outputSchema: OUTPUT_SCHEMAS["shamela_resolve"] as never,
            inputSchema: resolveInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runResolve(b.helper, b.catalog, args as Parameters<typeof runResolve>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 11. shamela_get_pages_range -----------
    server.registerTool(
        "shamela_get_pages_range",
        {
            title: L.toolTitles.shamela_get_pages_range,
            description:
                "Fetch N (1–20, default 5) consecutive pages from a downloaded book starting at start_page_id. Faster than calling shamela_get_page in a loop. Each page entry has page_id, printed_page, part, body, foot, comment. has_more flag indicates whether more pages exist after the returned range. Very long ranges are cut short to stay within a size budget; when that happens the response sets next_start_page_id and a `_display` hint — continue from there. For full chapters use shamela_get_book_section instead — it knows where the chapter ends. Example: shamela_get_pages_range({book_id:<id>, start_page_id:1, count:5}). Find downloaded book ids via shamela_list_downloaded_books.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_pages_range"] as never,
            inputSchema: getPagesRangeInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetPagesRange(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetPagesRange>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 12. shamela_get_book_section -----------
    server.registerTool(
        "shamela_get_book_section",
        {
            title: L.toolTitles.shamela_get_book_section,
            description:
                "Fetch every page under a chapter title. Resolves the chapter's start/end page range from the per-book SQLite (next-sibling-title boundary), then batch-reads the page contents. Capped at max_pages (default 30, max 100); sets `truncated:true` if the section is longer. Long sections also stop early on a character budget (even within max_pages) and return next_start_page_id + a `_display` hint to continue. Use shamela_get_toc to find title_ids, then this tool to read the matching section. Example: shamela_get_book_section({book_id:<id>, title_id:<title_id from get_toc>}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_book_section"] as never,
            inputSchema: getBookSectionInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetBookSection(b.helper, b.catalog, b.pages, args as Parameters<typeof runGetBookSection>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 13. shamela_get_citation -----------
    server.registerTool(
        "shamela_get_citation",
        {
            title: L.toolTitles.shamela_get_citation,
            description:
                "Format a citation in three styles. style='shamela' (default) replicates Shamela's UI copy-with-citation: «<book>» (<part>/ <page>):\\n«<text>». style='short' is a one-line inline reference: <author>، <book>، ص <page>. style='full' is the long form with the author's death year (book_date is deliberately not printed — it is Shamela's dating stamp, not a composition or print year), plus a `notes[]` array listing missing citation-grade fields (edition/publisher/city/editor — master.db doesn't have these; never fabricate). All numbers in output use Arabic-Indic digits. Examples: shamela_get_citation({book_id:<id>, page_id:<page_id>, style:'shamela'}), shamela_get_citation({book_id:<id>, page_id:<page_id>, text:'<quoted passage>', style:'shamela'}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_citation"] as never,
            inputSchema: getCitationInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetCitation(b.catalog, b.pages, args as Parameters<typeof runGetCitation>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 14. shamela_search_quran -----------
    server.registerTool(
        "shamela_search_quran",
        {
            title: L.toolTitles.shamela_search_quran,
            description:
                "Search the Qur'an (6,236 verses, Hafs from Asim, Egyptian إملائي orthography) via the pre-built aya/ Lucene index. Ships zero-config — works on a fresh Shamela install. Returns aya_id (1..6236), surah, surah_name, aya, body (full verse text), and a snippet with <mark>...</mark> around matches. Pair with shamela_get_aya to fetch a single verse with the Othmani Amiri rendering, or with shamela_get_tafseer_of_aya to find tafsir books that comment on a matching verse.",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_quran"] as never,
            inputSchema: searchQuranInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchQuran(b.helper, args as Parameters<typeof runSearchQuran>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 15. shamela_get_aya -----------
    server.registerTool(
        "shamela_get_aya",
        {
            title: L.toolTitles.shamela_get_aya,
            description:
                "Fetch a single Qur'anic verse by aya_id (1..6236, cumulative across surahs) OR by surah (1..114) + aya (1..N). Returns the verse text in three renderings: body (Egyptian إملائي, Hafs from Asim — the searchable form), amiri (Othmani Amiri rendering for display), majma (KFQPC Mushaf rendering). Pass either aya_id alone OR both surah and aya. Examples: shamela_get_aya({aya_id:1}) → al-Fatiha verse 1 (basmala); shamela_get_aya({surah:55, aya:1}) → Ar-Rahman verse 1.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_aya"] as never,
            inputSchema: getAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetAya(b.helper, args as Parameters<typeof runGetAya>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 16. shamela_get_tafseer_of_aya -----------
    server.registerTool(
        "shamela_get_tafseer_of_aya",
        {
            title: L.toolTitles.shamela_get_tafseer_of_aya,
            description:
                "List the tafsir books that Shamela's own pre-built service/tafseer.db join places a verse in, with page_id. Pass aya_id (1..6236) OR surah+aya; downloaded_only=false widens to the whole catalogue, including books not downloaded. That join is curated: it covers only a handful of books, and it ERRORS with SERVICE_KEY_NOT_FOUND when it holds nothing for the verse. For the user's real coverage prefer shamela_list_tafsirs_for_aya, which also places the verse from each downloaded tafsir's own chapter headings and so reaches many more books, and shamela_get_tafseer_texts to read them. Use this tool when you want Shamela's own join specifically, or the not-downloaded catalogue view the other two do not offer.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_tafseer_of_aya"] as never,
            inputSchema: getTafseerOfAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetTafseerOfAya(b.catalog, b.services, args as Parameters<typeof runGetTafseerOfAya>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 17. shamela_get_books_for_hadith -----------
    server.registerTool(
        "shamela_get_books_for_hadith",
        {
            title: L.toolTitles.shamela_get_books_for_hadith,
            description:
                "Given a Shamela hadith key (numeric identifier shared by all collections that record the same hadith), list every book that cites it. Uses Shamela's pre-built service/hadeeth.db join. By default filters to downloaded books only. Each result has book_id, book_name, author_name, page_id, downloaded flag. Pair with shamela_get_page to read the cited page. Useful for cross-collection hadith research (Bukhari + Muslim + Sunan + Musnad references for the same hadith), and for gathering a hadith's routes before assessing it — the tool reports where it occurs and never rules on its authenticity.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_books_for_hadith"] as never,
            inputSchema: getBooksForHadithInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetBooksForHadith(b.catalog, b.services, args as Parameters<typeof runGetBooksForHadith>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 18. shamela_list_downloaded_books -----------
    server.registerTool(
        "shamela_list_downloaded_books",
        {
            title: L.toolTitles.shamela_list_downloaded_books,
            description:
                "List the books actually downloaded on this user's machine (master.db.book.major_ondisk > 0). Returns book_id, book_name, author_name, category, book_date for each. Crucial for honest research scoping: shamela_search_pages only returns hits from downloaded books, so this tool tells the LLM what's actually searchable. Paginated via limit/offset. Pass `category_id` to restrict to one category. Each book reports content_status ('readable' vs 'downloaded_no_pages' = flagged but text not openable), and the response includes library_by_category — the distribution of the whole downloaded library across categories. Example: shamela_list_downloaded_books({limit:50}) → all downloaded books; shamela_list_downloaded_books({category_id:17}) → only الفقه الحنبلي.",
            outputSchema: OUTPUT_SCHEMAS["shamela_list_downloaded_books"] as never,
            inputSchema: listDownloadedBooksInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runListDownloadedBooks(b.catalog, b.pages, args as Parameters<typeof runListDownloadedBooks>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 19. shamela_get_book_parts -----------
    server.registerTool(
        "shamela_get_book_parts",
        {
            title: L.toolTitles.shamela_get_book_parts,
            description:
                "List the volumes/parts of a multi-volume book. Returns is_multi_volume flag, total_pages, and an array of parts each with part name (e.g. 'ج 1'), page_count, first_page_id, last_page_id. For single-volume books returns is_multi_volume:false and an empty parts array. Useful to know whether a citation needs a part designator. Example: shamela_get_book_parts({book_id:<id>}). Find downloaded book ids via shamela_list_downloaded_books.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_book_parts"] as never,
            inputSchema: getBookPartsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetBookParts(b.catalog, b.pages, args as Parameters<typeof runGetBookParts>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 20. shamela_get_page_services -----------
    server.registerTool(
        "shamela_get_page_services",
        {
            title: L.toolTitles.shamela_get_page_services,
            description:
                "Read the per-page services annotations (Qur'anic verses cited, hadith keys, isnād chains) for a specific (book_id, page_id). Returns has_services flag plus three arrays: ayat (cumulative aya_ids), hadeeth (hadith keys), esnad (chain strings). Many books — particularly non-hadith works — have no services and return has_services:false cleanly. Useful to pivot from a search hit to the Qur'anic/hadith content it discusses: pair the returned aya_ids with shamela_get_aya, or hadith keys with shamela_get_books_for_hadith. The `esnad` strings are the entry point for studying a chain narrator by narrator — resolve each name with shamela_search_authors.",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_page_services"] as never,
            inputSchema: getPageServicesInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetPageServices(b.catalog, b.pages, args as Parameters<typeof runGetPageServices>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 21. shamela_search_phrase -----------
    server.registerTool(
        "shamela_search_phrase",
        {
            title: L.toolTitles.shamela_search_phrase,
            description:
                "Exact-phrase and proximity search the regular search lacks. mode='phrase' matches the query words as a CONSECUTIVE phrase (e.g. «خيار المجلس» only where those two words are adjacent). mode='near' matches pages where the words occur within `distance` words of each other in any order (e.g. «بيع» near «قبض» within 5 words) — ideal for fiqh questions where related terms sit close but not adjacent. Two-stage: finds candidate pages where all words co-occur, then verifies adjacency/proximity in the full page text. Pass `scope` (book_ids/author_ids/category_ids) to cover large libraries reliably. Returns book name, author, printed page, and a snippet. Examples: shamela_search_phrase({query:'خيار المجلس'}), shamela_search_phrase({query:'بيع قبض', mode:'near', distance:5, scope:{category_ids:[17]}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_phrase"] as never,
            inputSchema: searchPhraseInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchPhrase(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchPhrase>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 22. shamela_search_hadith -----------
    server.registerTool(
        "shamela_search_hadith",
        {
            title: L.toolTitles.shamela_search_hadith,
            description:
                "Find a hadith by its TEXT (not its numeric key). Text-searches the downloaded library (matn + footnotes), reads each matching page's service annotations for hadith keys, then resolves each key's cross-collection takhrij via hadeeth.db. Returns matched pages (snippets often show the printed takhrij «رواه البخاري ومسلم») plus cross-book takhrij where service keys exist. Note: fiqh/usul libraries frequently lack service keys on cited-hadith pages — the snippets still carry the printed takhrij. For takhrij work, search options.search_in:['foot'] alone to target editors' footnotes, where the printed referencing lives. To follow a chain narrator by narrator, read the page with shamela_get_page_services (its `esnad` array) and look each name up with shamela_search_authors. Example: shamela_search_hadith({query:'إنما الأعمال بالنيات'}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_hadith"] as never,
            inputSchema: searchHadithInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchHadith(b.helper, b.catalog, b.pages, b.services, args as Parameters<typeof runSearchHadith>[4]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 23. shamela_health -----------
    server.registerTool(
        "shamela_health",
        {
            title: L.toolTitles.shamela_health,
            description:
                "Self-diagnostics. Returns server version, catalog/author/category counts, downloaded-book count, and a spot-check that reads a sample of downloaded books, spread evenly across the library, to confirm their pages are readable. Reaching this tool at all proves the backend booted; the spot-check separates 'server fine' from 'library path / content problems'. Use it FIRST when Shamela tools seem missing, empty, or erroring. Cheap and read-only.",
            outputSchema: OUTPUT_SCHEMAS["shamela_health"] as never,
            inputSchema: healthInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                let b: Backend | null = null;
                let partial: PartialBackend | null = null;
                try {
                    b = await provider.get();
                } catch (startupError) {
                    // The extension is not working. Saying why IS this tool's job,
                    // so it must not fail with everything else (issue #42).
                    partial = await provider.partial(startupError);
                }
                const r = b
                    ? await runHealth(
                          b.catalog,
                          b.pages,
                          b.helper,
                          b.ayaIndex,
                          args as Parameters<typeof runHealth>[4],
                          undefined,
                          b.paths,
                      )
                    : await runHealth(
                          partial!.catalog,
                          partial!.pages,
                          null,
                          null,
                          args as Parameters<typeof runHealth>[4],
                          { startupError: partial!.startupError, paths: partial!.paths },
                      );
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 24. shamela_search_exact -----------
    server.registerTool(
        "shamela_search_exact",
        {
            title: L.toolTitles.shamela_search_exact,
            description:
                "Exactness-preserving search the regular search cannot do: it honors diacritics (التشكيل), hamza/alef forms (ٱآأإ vs bare ا, plus ؤ ئ ء ى ة), and digit systems (Arabic-Indic ٠-٩ vs Western 0-9). shamela_search_pages folds all of these away (preserve_* return OPTION_NOT_SUPPORTED). Two-stage, no index change: (1) normalized AND-search gathers candidates; (2) each candidate's FULL raw SQLite text is verified in Node, folding ONLY the features you did NOT ask to preserve. Type the query WITH the diacritics/hamza/digits to enforce; enable at least one flag in `preserve`. Broad searches may miss matches outside the bounded candidate window (`candidate_cap_hit`/`total_candidates_scanned` report it) — pass `scope` for large libraries. Examples: shamela_search_exact({query:'أحمد', preserve:{preserve_hamza:true}}) won't match «احمد»; shamela_search_exact({query:'عِلْم', preserve:{preserve_diacritics:true}}) won't match «عَلَم».",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_exact"] as never,
            inputSchema: searchExactInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchExact(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchExact>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 25. shamela_search_boolean -----------
    server.registerTool(
        "shamela_search_boolean",
        {
            title: L.toolTitles.shamela_search_boolean,
            description:
                "Boolean search the AND-only regular search lacks — combines OR (any_of) and NOT (none_of) with AND (all_of). `all_of`: terms that must ALL appear (intersection). `any_of`: at least ONE must appear (union), intersected with all_of. `none_of`: pages containing ANY of these are excluded. At least one of all_of/any_of is required. The engine evaluates ((∩ all_of) ∩ (∪ any_of)) minus (∪ none_of) over EVERY page it holds, so the exclusion is exhaustive and `total_in_window` is the true match count; `candidate_cap_hit` and `none_of_within_window` remain in the output and are always false. `subqueries[]` reports each term's own total, and each result's `matched_terms` says which terms that page actually carries. `scope` narrows the question; it is no longer needed for reliability. Examples: shamela_search_boolean({all_of:['الوقف'], any_of:['المسجد','المقبرة'], none_of:['البيع'], scope:{category_ids:[17]}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_search_boolean"] as never,
            inputSchema: searchBooleanInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runSearchBoolean(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchBoolean>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 26. shamela_root_stats -----------
    server.registerTool(
        "shamela_root_stats",
        {
            title: L.toolTitles.shamela_root_stats,
            description:
                "Profile how widely an Arabic root spreads across the DOWNLOADED library, aggregated by category / Hijri century / book / author. Runs ONE morphological (AlKhalil) page search for the root — all derived forms are counted (صابر/يصبر/اصطبار for صبر) — and returns the DISTRIBUTION only, not snippets. `total_hits` is EXACT, and so is the by-category/century/book/author breakdown: it is counted over EVERY matching page. Only when that pass exceeds its time budget does it fall back to a top-5,000 sample — `coverage_basis` says which happened ('all_results' or 'window'), and when `coverage_capped` is true the bucket counts are floors and shares are indicative. Morphology accuracy on classical Arabic is ~0.80 — read counts as reach, not exact tallies. Pass `scope` to profile a slice. Examples: shamela_root_stats({root:'صبر'}), shamela_root_stats({root:'رحم', scope:{category_ids:[17]}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_root_stats"] as never,
            inputSchema: rootStatsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runRootStats(b.helper, b.catalog, args as Parameters<typeof runRootStats>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 27. shamela_books_by_period -----------
    server.registerTool(
        "shamela_books_by_period",
        {
            title: L.toolTitles.shamela_books_by_period,
            description:
                "Catalog filter that keeps the two DATE FIELDS as separate AND-combined constraints (unlike scope.period_*, which unions them). composed_from/composed_to bound book.book_date — Shamela's DATING year, NOT a composition year: it equals the main author's death year for 8,467 of 8,593 books, so it cannot answer 'what was composed in this century'. died_from/died_to bound the MAIN AUTHOR's death year, which is the dimension the catalogue records well. A book matches only if it satisfies ALL provided constraints at once (composition-year AND death-year AND category AND downloaded) — an intersection, never a union. At least one of the four bounds is required. Also accepts category_id, downloaded_only, limit/offset. Returns book_id, book_name, main author + death_year, book_date, category, downloaded flag, and a ready-to-use book_ids[] to pass as scope.book_ids. Use for 'books by authors who died in a period' — e.g. died_from:700, died_to:800 for 8th-century-Hijri authors. Do not present a composed_* result as a claim about when books were written.",
            outputSchema: OUTPUT_SCHEMAS["shamela_books_by_period"] as never,
            inputSchema: booksByPeriodInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runBooksByPeriod(b.catalog, b.pages, args as Parameters<typeof runBooksByPeriod>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 28. shamela_list_tafsirs_for_aya -----------
    server.registerTool(
        "shamela_list_tafsirs_for_aya",
        {
            title: L.toolTitles.shamela_list_tafsirs_for_aya,
            description:
                "Per-verse tafsir coverage over the user's DOWNLOADED tafsir shelves (categories 3, 4 AND 5), plus any index hit from another shelf (marked in_tafsir_categories:false). Consults TWO indexes: Shamela's curated service/tafseer.db, and a verse→page index built per book from that book's OWN chapter headings — so far more downloaded tafsirs get placed than the curated table alone ever covered. Placed: 'indexed_covers' (Shamela's table), 'title_index' (the book's headings), 'title_index_group' (a heading covering a range that includes this verse); each carries page_id, printed page, title_id and confidence. Not placed: 'covered_no_locus' (indexed, no marker for this verse), 'indexed_no_entry_for_this_aya', 'not_indexed_coverage_unknown' (nothing places verses in this book — NOT evidence it lacks commentary). 'index_pending': one call indexes at most 8 new books, the rest come back in index_pending_book_ids — call again to continue. Never text-searches. Pass aya_id (1..6236) OR surah+aya. Examples: shamela_list_tafsirs_for_aya({surah:2, aya:255}), shamela_list_tafsirs_for_aya({aya_id:262}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_list_tafsirs_for_aya"] as never,
            inputSchema: listTafsirsForAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runListTafsirsForAya(b.catalog, b.services, b.pages, b.helper, b.ayaIndex, args as Parameters<typeof runListTafsirsForAya>[5]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 29. shamela_get_tafseer_texts -----------
    server.registerTool(
        "shamela_get_tafseer_texts",
        {
            title: L.toolTitles.shamela_get_tafseer_texts,
            description:
                "Fetch the tafsir texts of one verse from several books in a single call. Index-driven, never text-searched: a page is fetched only where the verse is actually placed — by Shamela's curated service/tafseer.db, or by the verse→page index built from a book's OWN chapter headings, which reaches most of the downloaded tafsir shelf. With no book_ids the whole shelf (categories 3, 4, 5) is swept, Shamela-placed books first. Pass aya_id OR surah+aya; book_ids restricts sources, max_sources (default 5) caps how many are read. Per-source status: 'ok' (placed by Shamela's table), 'ok_titles' (by the book's headings), 'ok_group' (a heading covering a range including this verse), and — with no text — 'no_entry_for_this_aya', 'not_indexed', 'not_downloaded', 'index_pending' (one call indexes at most 8 new books; call again to continue). Each source carries attribution (book_name, author, death_year, printed_page, page_id) and continuation: text_part/text_total_parts/text_has_more (read on with shamela_get_page body_part=2) and next_page_id for commentary running past the page. A character budget may cut the response; remaining_book_ids + _display say how to continue. Examples: shamela_get_tafseer_texts({surah:2, aya:255}), shamela_get_tafseer_texts({surah:1, aya:5, book_ids:[43], max_sources:2}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_get_tafseer_texts"] as never,
            inputSchema: getTafseerTextsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runGetTafseerTexts(b.helper, b.catalog, b.services, b.pages, b.ayaIndex, args as Parameters<typeof runGetTafseerTexts>[5]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 30. shamela_guide -----------
    server.registerTool(
        "shamela_guide",
        {
            title: L.toolTitles.shamela_guide,
            description:
                "The extension's built-in Arabic user guide (user-facing markdown). Returns the full guide, or one section via the optional `section`: 'الكل' (default — the full guide), 'الأدوات' (every tool with natural-request examples), 'النصائح' (researcher tips). An unrecognized section value falls back to the full guide with a note. Serves the user when they ask what the extension can do or how to use it. Pure text — needs no library access and never fails, so it also works when the Shamela install itself is missing. Examples: shamela_guide({}), shamela_guide({section:'الأدوات'}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_guide"] as never,
            inputSchema: guideInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const r = runGuide(args as Parameters<typeof runGuide>[0]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 31. shamela_suggest_download -----------
    server.registerTool(
        "shamela_suggest_download",
        {
            title: L.toolTitles.shamela_suggest_download,
            description:
                "Look a book up in Shamela's FULL catalogue — downloaded or not — and say what can be done about it: already on this machine, offered for download (with its id and its shamela.ws page), or in the catalogue but not offered, in which case the user must look elsewhere. Use it whenever research needs a book that searches cannot find: a work cited by a downloaded book, a source named in an editor's footnote, or a title the user asked for. An empty search result does not say whether a book is missing from the library or missing from Shamela; this does. Downloads nothing and contacts no server — the Shamela app performs the download, and the extension picks the book up within seconds, so the same conversation can continue. Examples: shamela_suggest_download({query:'مغني المحتاج'}), shamela_suggest_download({book_ids:[6658]}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_suggest_download"] as never,
            inputSchema: suggestDownloadInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = runSuggestDownload(b.catalog, args as Parameters<typeof runSuggestDownload>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 32. shamela_verify_quote -----------
    server.registerTool(
        "shamela_verify_quote",
        {
            title: L.toolTitles.shamela_verify_quote,
            description:
                "Check whether a quotation is really on the page it is credited to. Returns one of five verdicts — 'verbatim' (present with diacritics, hamza spelling and digits exactly as typed), 'differs' (ALL of it present, with the differing axes NAMED), 'partial' (a run of it present and the rest worded otherwise — what a quotation carried from memory looks like; matched_words says how much), 'not_found', or 'unverifiable' (the book credited is not downloaded, so nothing was examined and the answer neither confirms nor denies) — together with WHERE on each page it sits: body is the author's own matn, foot is the modern editor's footnote, and a quotation taken from a footnote and attributed to the author is a misattribution however exactly it matches. Pass book_id (and page_id) to check a specific claim, or neither to search the downloaded library for whoever actually said it. When a claimed page does not hold the quotation, the page whose PRINTED number equals the number given is checked too and reported as printed_page_confusion — page_id is Shamela's own running count and a hand-carried citation almost always carries the printed page instead. Use it on any quotation whose source matters and whose provenance you have not personally checked, including one produced earlier in this same conversation. A 'not_found' is a statement about the books downloaded on this machine, never about the tradition. Examples: shamela_verify_quote({quote:'إنما الأعمال بالنيات', book_id:9942, page_id:17}), shamela_verify_quote({quote:'القياس في اللغة التقدير'}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_verify_quote"] as never,
            inputSchema: verifyQuoteInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runVerifyQuote(
                    b.helper,
                    b.catalog,
                    b.pages,
                    args as Parameters<typeof runVerifyQuote>[3],
                );
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 33. shamela_scan_consensus -----------
    server.registerTool(
        "shamela_scan_consensus",
        {
            title: L.toolTitles.shamela_scan_consensus,
            description:
                "Locate where a fiqh question is declared settled and where it is declared open, in one sweep. Runs a lexicon of the fixed Arabic idioms by which agreement is claimed (أجمعوا، بالإجماع، لا خلاف، لا نعلم خلافا…) and disagreement is recorded (اختلفوا، قولان، روايتان، وجهان، فيه خلاف…) against your subject, each formula required NEAR the subject and each held together as a phrase. Returns per formula: pages, books, the formula's own total in the same scope (the base rate — «وجهان» is a Shafii habit and «روايتان» a Hanbali one, so raw cross-school counts measure idiom, not dispute), how the pages fall across the four schools, and quoted witnesses. There is deliberately NO verdict field and no total of one column against the other: the index cannot see negation, attribution or rebuttal, so «لا إجماع في المسألة» and «ادعى الإجماع وليس كذلك» both carry the formula and neither asserts it. Read the witnesses; the counts only say where to look. Use it BEFORE arguing a question, to find out whether it is disputed at all. Examples: shamela_scan_consensus({question:'المسح على الخفين'}), shamela_scan_consensus({question:'الاستصناع', families:['ijmaa'], scope:{madhhab:['hanafi']}}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_scan_consensus"] as never,
            inputSchema: scanConsensusInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runScanConsensus(
                    b.helper,
                    b.catalog,
                    b.pages,
                    args as Parameters<typeof runScanConsensus>[3],
                );
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 34. shamela_research_scope -----------
    server.registerTool(
        "shamela_research_scope",
        {
            title: L.toolTitles.shamela_research_scope,
            description:
                "Measure how much of each madhhab a term actually reached, and return it as a receipt with a row for every school INCLUDING the empty ones. Each row says which of three things its number means: 'found', 'silent' (the school's books are on this machine and none of them says it — the only zero that is evidence about the tradition), or 'cannot_tell' (none of its books is downloaded, so the zero is about this disk and nothing else). Those two zeros are opposite conclusions and look identical in an ordinary search result, which is why this exists: report a school as silent ONLY from a row that says silent. Pass `synonyms` when a school may name the question differently — a school using another term is not a school that is silent. A fifth row counts the pages outside all four schools (general fiqh, usul, fatwa), so the rows are never read as a total. Costs one search per term. Use it BEFORE writing that a school has no view, and after a comparative sweep to see what the sweep missed. Examples: shamela_research_scope({term:'الاستصناع'}), shamela_research_scope({term:'خيار المجلس', synonyms:['خيار المتبايعين']}).",
            outputSchema: OUTPUT_SCHEMAS["shamela_research_scope"] as never,
            inputSchema: researchScopeInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await provider.get();
                const r = await runResearchScope(
                    b.helper,
                    b.catalog,
                    args as Parameters<typeof runResearchScope>[2],
                );
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // A 32nd tool, shamela_dump_book, was built here and withdrawn before
    // 2.0.0 shipped. It worked — but its only sink was the conversation, and
    // measured on الروض المربع (1,607 pages) a full export is 67 calls and
    // ~1.2M characters: it invited a loop that dies a third of the way in,
    // while its own last line said "أكمِل التصدير". Export belongs in a local
    // script that writes a file, not in a tool that can only speak into a
    // context window. See FUTURE-IDEAS-STUDY item 63.

    // ----------- Resources (attachable catalogs/schema) -----------
    server.registerResource(
        "categories",
        "shamela://categories",
        { title: L.resources.categories.title, description: L.resources.categories.description, mimeType: "application/json" },
        async (uri) => {
            const b = await provider.get();
            const r = runListCategories(b.catalog, listCategoriesInput.parse({ include_counts: true, response_format: "json" }));
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.structuredContent, null, 2) }] };
        },
    );
    server.registerResource(
        "downloaded",
        "shamela://downloaded",
        { title: L.resources.downloaded.title, description: L.resources.downloaded.description, mimeType: "application/json" },
        async (uri) => {
            const b = await provider.get();
            const tally = new Map<number, number>();
            const books = Array.from(b.catalog.downloadedBookIds()).map((id) => {
                const rec = b.catalog.bookRecord(id);
                const cid = rec?.book_category ?? -1;
                tally.set(cid, (tally.get(cid) ?? 0) + 1);
                return {
                    book_id: id,
                    book_name: rec?.book_name ?? null,
                    author_name: rec ? b.catalog.mainAuthorName(rec) : null,
                    category_id: rec?.book_category ?? null,
                    category: rec ? b.catalog.categoryPath(rec.book_category)[0] ?? null : null,
                    book_date: rec?.book_date ?? null,
                };
            });
            const by_category = Array.from(tally.entries())
                .map(([cid, count]) => ({
                    category_id: cid >= 0 ? cid : null,
                    category_name: cid >= 0 ? b.catalog.category(cid)?.category_name ?? String(cid) : null,
                    count,
                }))
                .sort((x, y) => y.count - x.count);
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ total: books.length, by_category, books }, null, 2) }] };
        },
    );
    server.registerResource(
        "guide",
        "shamela://guide",
        { title: L.resources.guide.title, description: L.resources.guide.description, mimeType: "text/markdown" },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildGuideText() }] }),
    );
    server.registerResource(
        "schema",
        "shamela://schema",
        { title: L.resources.schema.title, description: L.resources.schema.description, mimeType: "text/markdown" },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: L.schemaDoc }] }),
    );
    server.registerResource(
        "status",
        "shamela://status",
        { title: L.resources.status.title, description: L.resources.status.description, mimeType: "application/json" },
        async (uri) => {
            const b = await provider.get();
            const r = await runHealth(
                b.catalog,
                b.pages,
                b.helper,
                b.ayaIndex,
                healthInput.parse({ response_format: "json" }),
                undefined,
                b.paths,
            );
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.structuredContent, null, 2) }] };
        },
    );

    return server;
}

/**
 * A bare MCP server carrying this project's identity, capabilities and model
 * instructions — the same three a host would otherwise have to copy.
 */
export function createMcpServer(): McpServer {
    const L = messages();
    return new McpServer(
        { name: "shamela", version: VERSION },
        { capabilities: { tools: {}, resources: {} }, instructions: L.instructions },
    );
}

/**
 * Register the whole tool surface on a server the caller owns.
 *
 * This is the entry point for anyone embedding this library. `deps` carries
 * everything environment-specific — where the Shamela install is, how to read
 * its SQLite, how to reach the search helper — and nothing else is required.
 *
 * Returns the backend it built, because the caller owns its lifetime: warm it
 * after the handshake (`provider.get()`), and release it at shutdown
 * (`provider.close()`).
 */
export function registerAllTools(server: McpServer, deps: ShamelaDeps): BackendProvider {
    const provider = createBackendProvider(deps);
    registerTools(server, provider);
    return provider;
}

/**
 * Build a server around a backend that already exists.
 *
 * The tests use this: they construct one backend for the whole suite and would
 * otherwise pay a JVM cold start per file. `getPartialBackend` is what
 * `shamela_health` falls back to when `getBackend` throws; hosts that can still
 * read SQLite when the helper is unavailable should pass it, since without one
 * the health report loses everything it could still have said.
 */
export function createServer(
    getBackend: () => Promise<Backend>,
    getPartialBackend?: (startupError: unknown) => Promise<PartialBackend>,
): McpServer {
    return registerTools(createMcpServer(), {
        get: getBackend,
        partial: async (startupError) =>
            getPartialBackend
                ? getPartialBackend(startupError)
                : { catalog: null, pages: null, paths: null, startupError },
        close: () => {},
    });
}

/**
 * Count what was actually registered, rather than trusting a number typed into
 * a log line. The hand-written count had already drifted once, and a startup
 * line that misreports the tool set is the least useful place to be wrong.
 */
export function countRegistered(server: McpServer): { tools: number; resources: number } {
    const bag = server as unknown as {
        _registeredTools?: Record<string, unknown>;
        _registeredResources?: Record<string, unknown>;
        _registeredResourceTemplates?: Record<string, unknown>;
    };
    return {
        tools: Object.keys(bag._registeredTools ?? {}).length,
        resources:
            Object.keys(bag._registeredResources ?? {}).length +
            Object.keys(bag._registeredResourceTemplates ?? {}).length,
    };
}

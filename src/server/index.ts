/**
 * shamela-mcp — MCP server entry point.
 *
 * Spins up a Java helper subprocess on first tool call, exposes 30 tools
 * via `registerTool`, returns dual content (markdown text + structuredContent).
 * All tool handlers wrap their backing implementations in a shared error
 * envelope that maps ShamelaError / HelperError / ShamelaNotFoundError to
 * MCP `isError: true` content.
 */

import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { Catalog } from "./catalog.js";
import { VERSION } from "./constants.js";
import { errorCode, formatErrorMessage } from "./errors.js";
import { buildGuideText } from "./guide.js";
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

// @ts-expect-error — esbuild `--loader:.wasm=binary` inlines this as a Uint8Array.
import sqlWasm from "sql.js/dist/sql-wasm.wasm";

const SQL_WASM_BINARY: Uint8Array = sqlWasm as unknown as Uint8Array;

function logInfo(msg: string): void {
    process.stderr.write(`[shamela-mcp] ${msg}\n`);
}

/**
 * Server-level guidance surfaced to the model (anti-hallucination governance).
 * The client shows this to the LLM to shape how it uses the tools.
 */
const SERVER_INSTRUCTIONS = `أنت متصل بمكتبة المستخدم المحلية من «المكتبة الشاملة» للقراءة فقط. التزم بما يلي:
- لا تنسب نصًّا إلى كتابٍ إلا إذا جاء فعلًا من نتيجة أداة؛ ولا تُكمِل النصوص أو الأسانيد من معرفتك العامة.
- ميِّز دائمًا بين المتن (body) والحاشية (foot)؛ الحاشية كلام المحقِّق أو المعلِّق لا كلام المصنِّف، فلا تنسبها إليه.
- عند الاستشهاد استعمل أداة shamela_get_citation، وصرِّح بحال الترقيم إن كان «بترقيم الشاملة آليًّا» ولا تَعُدَّه ترقيم المطبوع.
- لا تختلق بيانات نشرٍ (ناشر/طبعة/محقِّق) غير موجودة؛ إذا نقصت فاذكر أنها غير متوفرة.
- البحث يقتصر على الكتب المنزَّلة على جهاز المستخدم؛ إن لم تظهر نتائج فقد لا يكون الكتاب منزَّلًا.
- للبحث عن عبارةٍ متتاليةٍ بالضبط أو كلمتين متقاربتين استعمل shamela_search_phrase بدل shamela_search_pages.
- لا تُغرِق المستخدم بنصٍّ طويل: get_page يقطّع المتن (body_part / body_total_parts / body_has_more)، وget_pages_range وget_book_section يقفان عند ميزانية الحجم ويُرجعان next_start_page_id؛ متى طال النص فاعرضه على أجزاء أو اسأل المستخدم عن طريقة العرض (انظر الحقل _display).
- المكتبة الشاملة متعددة التصنيفات (41 تصنيفًا، وكتب التفسير وحدها موزَّعة على التصنيفات 3 و4 و5)؛ فضيّق نطاق البحث والتصفّح بالتصنيف المناسب عبر category_id.
- للتفسير: أداة get_tafseer_of_aya فهرسها منتقًى؛ فلبيان تغطية التفاسير المنزَّلة لآيةٍ بعينها استعمل shamela_list_tafsirs_for_aya، ولجلب النصوص من عدة مصادر دفعةً واحدة shamela_get_tafseer_texts (تفاصيل القيود في وصف كل أداة).
- الحياد الترجيحي: اعرض أقوال المذاهب منسوبةً بأدلتها دون ترجيح إلا أن يطلبه المستخدم، وميّز النقل عن الاستنباط.
- في الكتب التراثية ذات الفصول غير المعنونة (فهارسها «فصل» مكررة بلا عناوين) لا تكتفِ بـ get_toc للتنقل؛ اجمعه مع shamela_search_pages محصورًا بالكتاب عبر scope.book_ids.
- أي سؤال عن قدرات الإضافة أو طريقة استخدامها → استدعِ shamela_guide واعرض محتواه.`;

/** Developer-facing data-model summary, exposed as the shamela://schema resource. */
const SHAMELA_SCHEMA_DOC = `# مخطط بيانات المكتبة الشاملة (موجز للمطوّرين)
- **master.db**: فهرس الكتب والمؤلفين والتصنيفات. الجدول \`book\`: book_id, book_name, book_category, book_date, authors, major_ondisk (الكتاب مُنزَّل إن > 0).
- **book/<id%1000>/<id>.db**: قاعدة كل كتاب. الجدول \`page\` (id, part, page, number, services) والجدول \`title\` (فهرس الأبواب).
- **service/{tafseer,hadeeth,trajim}.db**: جداول الربط — \`service(key_id, book_id, page_id)\` و\`inservice(book, user_excluded)\`. key_id = aya_id للتفسير، ومفتاح الحديث للحديث. (ملاحظة: هذه الجداول منتقاة ولا تغطي كل التفاسير المنزّلة.)
- **فهارس Lucene**: نصوص الصفحات (body/foot/comment) والعناوين والمؤلفين والآيات — يقرؤها المساعد الجافي.
- القراءة فقط؛ لا تُكتب ملفات الشاملة أبدًا.`;

export interface Backend {
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

/** Build the long-lived backend (paths, catalog, page/service stores, JVM helper). */
export async function createBackend(): Promise<Backend> {
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
    return { helper: h, catalog, pages, services };
}

/**
 * Build the MCP server with all 30 tools registered. The `getBackend` callback
 * lets callers wire either an already-constructed backend (tests) or a lazy
 * initializer (the stdio entry point).
 */
export function createServer(getBackend: () => Promise<Backend>): McpServer {
    const server = new McpServer(
        { name: "shamela", version: VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
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
                "Search Shamela's title/ Lucene index for chapter and section titles. Same query/scope/options/pagination shape as shamela_search_pages but matches title text rather than page bodies. After finding a matching title, use shamela_get_book_section(book_id, title_id) to read the full section. Examples: shamela_search_titles({query:'باب الصيام'}), shamela_search_titles({query:'تعريف', scope:{book_ids:[<id from shamela_resolve or shamela_list_downloaded_books>]}}).",
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
                "Search Shamela's ~3,200-author catalog by name or biography text. Pre-built index — no downloads needed. No scope (authors aren't scoped by category/period). Returns author name, Hijri death year, and book count. Arabic scholars go by several name forms — when a query misses, try the kunya, nisba, and shuhra variants before concluding absence (جرّب الكنية والنسبة والشهرة: ابن قدامة / الموفق / المقدسي). Use the resulting author_id with shamela_get_author for full details, or with scope.author_ids in shamela_search_pages/_books to filter by that author. Examples: shamela_search_authors({query:'ابن عثيمين'}), shamela_search_authors({query:'الشافعي', options:{wildcards:false}}).",
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
                "Fetch the full text of one Shamela page (book_id, page_id). Returns body (matn), foot (footnotes), comment (user notes), printed_page label, prev/next page ids, the chapter ancestor chain (root → leaf), and the category path. Set keep_html=true to preserve inline <span data-type='title'> markers; default strips them. The book must be downloaded (BOOK_NOT_DOWNLOADED otherwise). For batch reads use shamela_get_pages_range; for full chapters use shamela_get_book_section. Long pages: the body is split into parts of ~4000 chars — `body_part` selects the 1-based part, and body_total_parts/body_has_more report the split (footnote/comment come with part 1; a `_display` hint advises when to ask the user how to show it).",
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
                "Fetch a downloaded book's table of contents. Two modes: (a) subtree mode (default) — pass parent_id (0 = top level) and depth (1–5) to get a tree of titles; (b) ancestor-chain mode — pass containing_page_id to get the root → leaf chapter chain that contains that page. Returns title_id, title_text, page_id, has_children for each entry. Use the title_id with shamela_get_book_section to read the section. Examples: shamela_get_toc({book_id:<id>, depth:1}) lists top-level chapters; shamela_get_toc({book_id:<id>, containing_page_id:17}) returns the chapter containing page 17. Find downloaded book ids via shamela_list_downloaded_books or shamela_resolve.",
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
                "Fetch full metadata for a book by book_id. Returns book_name, all authors (main + co), category, book_type (printed/manuscript/journal/thesis/electronic/audio), book_date (Hijri composition year), printed flag, downloaded flag (true ONLY when both master.db says so AND the per-book SQLite has page rows), publication_date (DDMMYYYY Hijri from meta_data), sub_books, and a `notes` array listing citation-grade fields master.db doesn't have (edition/publisher/city/editor — never fabricate these). Find ids via shamela_resolve('book name') or shamela_list_downloaded_books. Works on any catalog book whether downloaded or not.",
            inputSchema: getBookInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetBook(b.catalog, b.pages, b.helper, args as Parameters<typeof runGetBook>[3]);
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
                "List all 41 categories in Shamela's catalog. Categories are flat (no parent_id, no transitive expansion). Each entry has category_id, category_name, and book_count (total books in catalog under that category). Use category_id values with scope.category_ids in search_pages / search_books to narrow searches. Set include_counts=false to skip the book counts (slightly faster but counts are cached so cost is negligible). Each entry also reports downloaded_count (books in that category present on THIS machine), and downloaded_only=true lists only categories where the user has downloads — useful because Shamela is a 41-category library and tafsir alone spans categories 3 (التفسير), 4 (علوم القرآن وأصول التفسير), and 5 (التجويد والقراءات).",
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
                "Fetch N (1–20, default 5) consecutive pages from a downloaded book starting at start_page_id. Faster than calling shamela_get_page in a loop. Each page entry has page_id, printed_page, part, body, foot, comment. has_more flag indicates whether more pages exist after the returned range. Very long ranges are cut short to stay within a size budget; when that happens the response sets next_start_page_id and a `_display` hint — continue from there. For full chapters use shamela_get_book_section instead — it knows where the chapter ends. Example: shamela_get_pages_range({book_id:<id>, start_page_id:1, count:5}). Find downloaded book ids via shamela_list_downloaded_books.",
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
                "Fetch every page under a chapter title. Resolves the chapter's start/end page range from the per-book SQLite (next-sibling-title boundary), then batch-reads the page contents. Capped at max_pages (default 30, max 100); sets `truncated:true` if the section is longer. Long sections also stop early on a character budget (even within max_pages) and return next_start_page_id + a `_display` hint to continue. Use shamela_get_toc to find title_ids, then this tool to read the matching section. Example: shamela_get_book_section({book_id:<id>, title_id:<title_id from get_toc>}).",
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
                "Format a citation in three styles. style='shamela' (default) replicates Shamela's UI copy-with-citation: «<book>» (<part>/ <page>):\\n«<text>». style='short' is a one-line inline reference: <author>، <book>، ص <page>. style='full' is the long form with author death year and book composition year, plus a `notes[]` array listing missing citation-grade fields (edition/publisher/city/editor — master.db doesn't have these; never fabricate). All numbers in output use Arabic-Indic digits. Examples: shamela_get_citation({book_id:<id>, page_id:<page_id>, style:'shamela'}), shamela_get_citation({book_id:<id>, page_id:<page_id>, text:'<quoted passage>', style:'shamela'}).",
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
                "Given a Qur'anic verse, list every tafsir book in the catalog that has a page commenting on it. Uses Shamela's pre-built service/tafseer.db join. Pass either aya_id (1..6236) OR surah+aya. By default returns only books the user has downloaded locally (downloaded_only=true) — set to false to see the full catalog of tafsirs that COULD comment on this verse if downloaded. Each result has book_id, book_name, author_name, page_id, downloaded flag. Pair with shamela_get_page(book_id, page_id) to read the actual tafsir text. NOTE: this uses a CURATED service index that may omit downloaded tafsirs (many tafsirs carry no per-page aya markers) — on some installs it returns only al-Tabari. For the user's full tafsir picture, also list downloaded books in the tafsir categories via shamela_list_downloaded_books(category_id=3) and (category_id=4); see coverage_note in the result.",
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
                "List the books actually downloaded on this user's machine (master.db.book.major_ondisk > 0). Returns book_id, book_name, author_name, category, book_date for each. Crucial for honest research scoping: shamela_search_pages only returns hits from downloaded books, so this tool tells the LLM what's actually searchable. Paginated via limit/offset. Pass `category_id` to restrict to one category. Each book reports content_status ('readable' vs 'downloaded_no_pages' = flagged but text not openable), and the response includes library_by_category — the distribution of the whole downloaded library across categories. Example: shamela_list_downloaded_books({limit:50}) → all downloaded books; shamela_list_downloaded_books({category_id:17}) → only الفقه الحنبلي.",
            inputSchema: listDownloadedBooksInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runListDownloadedBooks(b.catalog, b.pages, args as Parameters<typeof runListDownloadedBooks>[2]);
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
                "List the volumes/parts of a multi-volume book. Returns is_multi_volume flag, total_pages, and an array of parts each with part name (e.g. 'ج 1'), page_count, first_page_id, last_page_id. For single-volume books returns is_multi_volume:false and an empty parts array. Useful to know whether a citation needs a part designator. Example: shamela_get_book_parts({book_id:<id>}). Find downloaded book ids via shamela_list_downloaded_books.",
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
                "Read the per-page services annotations (Qur'anic verses cited, hadith keys, isnād chains) for a specific (book_id, page_id). Returns has_services flag plus three arrays: ayat (cumulative aya_ids), hadeeth (hadith keys), esnad (chain strings). Many books — particularly non-hadith works — have no services and return has_services:false cleanly. Useful to pivot from a search hit to the Qur'anic/hadith content it discusses: pair the returned aya_ids with shamela_get_aya, or hadith keys with shamela_get_books_for_hadith.",
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

    // ----------- 21. shamela_search_phrase -----------
    server.registerTool(
        "shamela_search_phrase",
        {
            title: "بحث بالعبارة والتقارب",
            description:
                "Exact-phrase and proximity search the regular search lacks. mode='phrase' matches the query words as a CONSECUTIVE phrase (e.g. «خيار المجلس» only where those two words are adjacent). mode='near' matches pages where the words occur within `distance` words of each other in any order (e.g. «بيع» near «قبض» within 5 words) — ideal for fiqh questions where related terms sit close but not adjacent. Two-stage: finds candidate pages where all words co-occur, then verifies adjacency/proximity in the full page text. Pass `scope` (book_ids/author_ids/category_ids) to cover large libraries reliably. Returns book name, author, printed page, and a snippet. Examples: shamela_search_phrase({query:'خيار المجلس'}), shamela_search_phrase({query:'بيع قبض', mode:'near', distance:5, scope:{category_ids:[17]}}).",
            inputSchema: searchPhraseInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchPhrase(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchPhrase>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 22. shamela_search_hadith -----------
    server.registerTool(
        "shamela_search_hadith",
        {
            title: "بحث عن حديث بنصه",
            description:
                "Find a hadith by its TEXT (not its numeric key). Text-searches the downloaded library (matn + footnotes), reads each matching page's service annotations for hadith keys, then resolves each key's cross-collection takhrij via hadeeth.db. Returns matched pages (snippets often show the printed takhrij «رواه البخاري ومسلم») plus cross-book takhrij where service keys exist. Note: fiqh/usul libraries frequently lack service keys on cited-hadith pages — the snippets still carry the printed takhrij. Example: shamela_search_hadith({query:'إنما الأعمال بالنيات'}).",
            inputSchema: searchHadithInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchHadith(b.helper, b.catalog, b.pages, b.services, args as Parameters<typeof runSearchHadith>[4]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 23. shamela_health -----------
    server.registerTool(
        "shamela_health",
        {
            title: "فحص خادم الشاملة",
            description:
                "Self-diagnostics. Returns server version, catalog/author/category counts, downloaded-book count, and a spot-check that the first downloaded book has readable pages. Reaching this tool at all proves the backend booted; the spot-check separates 'server fine' from 'library path / content problems'. Use it FIRST when Shamela tools seem missing, empty, or erroring. Cheap and read-only.",
            inputSchema: healthInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runHealth(b.catalog, b.pages, args as Parameters<typeof runHealth>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 24. shamela_search_exact -----------
    server.registerTool(
        "shamela_search_exact",
        {
            title: "بحث مطابق مع التشكيل والهمزات والأرقام",
            description:
                "Exactness-preserving search the regular search cannot do: it honors diacritics (التشكيل), hamza/alef forms (ٱآأإ vs bare ا, plus ؤ ئ ء ى ة), and digit systems (Arabic-Indic ٠-٩ vs Western 0-9). shamela_search_pages folds all of these away (preserve_* return OPTION_NOT_SUPPORTED). Two-stage, no index change: (1) normalized AND-search gathers candidates; (2) each candidate's FULL raw SQLite text is verified in Node, folding ONLY the features you did NOT ask to preserve. Type the query WITH the diacritics/hamza/digits to enforce; enable at least one flag in `preserve`. Broad searches may miss matches outside the bounded candidate window (`candidate_cap_hit`/`total_candidates_scanned` report it) — pass `scope` for large libraries. Examples: shamela_search_exact({query:'أحمد', preserve:{preserve_hamza:true}}) won't match «احمد»; shamela_search_exact({query:'عِلْم', preserve:{preserve_diacritics:true}}) won't match «عَلَم».",
            inputSchema: searchExactInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchExact(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchExact>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 25. shamela_search_boolean -----------
    server.registerTool(
        "shamela_search_boolean",
        {
            title: "بحث منطقي (و/أو/دون)",
            description:
                "Boolean search the AND-only regular search lacks — combines OR (any_of) and NOT (none_of) with AND (all_of). `all_of`: terms that must ALL appear (intersection). `any_of`: at least ONE must appear (union), intersected with all_of. `none_of`: pages containing ANY of these are excluded. At least one of all_of/any_of is required. Node-only set algebra over per-term AND-sub-searches: ((∩ all_of) ∩ (∪ any_of)) \\ (∪ none_of) on hit ids. Each sub-search returns a CAPPED window, so this is best-effort — `candidate_cap_hit` flags a capped term, `none_of_within_window` flags window-only exclusion, `subqueries[]` reports each term. STRONGLY prefer `scope` (an unscoped boolean over a large library is unreliable). Examples: shamela_search_boolean({all_of:['الوقف'], any_of:['المسجد','المقبرة'], none_of:['البيع'], scope:{category_ids:[17]}}).",
            inputSchema: searchBooleanInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runSearchBoolean(b.helper, b.catalog, b.pages, args as Parameters<typeof runSearchBoolean>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 26. shamela_root_stats -----------
    server.registerTool(
        "shamela_root_stats",
        {
            title: "انتشار جذر في المكتبة",
            description:
                "Profile how widely an Arabic root spreads across the DOWNLOADED library, aggregated by category / Hijri century / book / author. Runs ONE morphological (AlKhalil) page search for the root — all derived forms are counted (صابر/يصبر/اصطبار for صبر) — and returns the DISTRIBUTION only, not snippets. `total_hits` is EXACT; the by-category/century/book/author breakdown is built from at most 5,000 top-scoring hits (COVERAGE_CAP), so when `coverage_capped` is true the bucket counts are floors and shares are indicative. Morphology accuracy on classical Arabic is ~0.80 — read counts as reach, not exact tallies. Pass `scope` to profile a slice. Examples: shamela_root_stats({root:'صبر'}), shamela_root_stats({root:'رحم', scope:{category_ids:[17]}}).",
            inputSchema: rootStatsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runRootStats(b.helper, b.catalog, args as Parameters<typeof runRootStats>[2]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 27. shamela_books_by_period -----------
    server.registerTool(
        "shamela_books_by_period",
        {
            title: "كتب حسب المدة (تأليفًا ووفاةً)",
            description:
                "Catalog filter that keeps the TWO temporal dimensions DISTINCT (unlike scope.period_*, which conflates them). composed_from/composed_to bound the BOOK's composition year (book.book_date); died_from/died_to bound the MAIN AUTHOR's death year. A book matches only if it satisfies ALL provided constraints at once (composition-year AND death-year AND category AND downloaded) — an intersection, never a union. At least one of the four bounds is required. Also accepts category_id, downloaded_only, limit/offset. Returns book_id, book_name, main author + death_year, book_date, category, downloaded flag, and a ready-to-use book_ids[] to pass as scope.book_ids. Use when a question distinguishes 'books composed in a period' from 'books by authors who died in a period' — e.g. died_from:700, died_to:800 for 8th-century-Hijri authors.",
            inputSchema: booksByPeriodInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = runBooksByPeriod(b.catalog, args as Parameters<typeof runBooksByPeriod>[1]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 28. shamela_list_tafsirs_for_aya -----------
    server.registerTool(
        "shamela_list_tafsirs_for_aya",
        {
            title: "تغطية تفاسير آية",
            description:
                "Per-aya tafsir coverage report: cross-references the user's DOWNLOADED tafsir shelves (categories 3 AND 4 — tafsir spans both) against the curated service/tafseer.db index and reports an honest tri-state per book. status='indexed_covers' — the index maps this aya to a page in this book (page_id + printed page included); 'indexed_no_entry_for_this_aya' — the book participates in the index but has no entry for this aya; 'not_indexed_coverage_unknown' — the book is absent from the curated index, so coverage CANNOT be determined (explicitly NOT evidence the book lacks commentary on the verse). Index hits outside categories 3/4 (e.g. mawsuʿat) are included and marked in_tafsir_categories:false. Pass either aya_id (1..6236) OR surah+aya. Returns totals per status and a note about the curated-index limitation. Never text-searches; navigate unknown-status books via shamela_get_toc. Examples: shamela_list_tafsirs_for_aya({surah:2, aya:255}), shamela_list_tafsirs_for_aya({aya_id:262}).",
            inputSchema: listTafsirsForAyaInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runListTafsirsForAya(b.catalog, b.services, b.pages, args as Parameters<typeof runListTafsirsForAya>[3]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 29. shamela_get_tafseer_texts -----------
    server.registerTool(
        "shamela_get_tafseer_texts",
        {
            title: "جلب نصوص تفسير آية",
            description:
                "Fetch the actual tafsir texts of one aya across multiple sources in a single call. Strictly index-driven: fetches ONLY pages the curated service/tafseer.db maps to this aya (no text-search fallback — it misattributes verses via shared phrases and the basmala). Pass either aya_id OR surah+aya; optional book_ids restricts sources, max_sources (default 5) caps how many are fetched. Each source carries embedded attribution (book_name, author, death_year, printed_page, page_id) plus continuation: text_part/text_total_parts/text_has_more for long pages (continue with shamela_get_page body_part=2) and next_page_id for commentary spanning pages. Requested book_ids absent from the index get an explicit status ('not_indexed' / 'no_entry_for_this_aya') with no text. The overall response respects a character budget; when cut, remaining_book_ids + a _display hint say how to continue. Use shamela_list_tafsirs_for_aya first to see coverage. Examples: shamela_get_tafseer_texts({surah:2, aya:255}), shamela_get_tafseer_texts({surah:1, aya:5, book_ids:[43], max_sources:2}).",
            inputSchema: getTafseerTextsInputShape,
            annotations: COMMON_ANNOTATIONS,
        },
        async (args) => {
            try {
                const b = await getBackend();
                const r = await runGetTafseerTexts(b.helper, b.catalog, b.services, b.pages, args as Parameters<typeof runGetTafseerTexts>[4]);
                return r as unknown as ToolResult;
            } catch (e) { return wrapErr(e); }
        },
    );

    // ----------- 30. shamela_guide -----------
    server.registerTool(
        "shamela_guide",
        {
            title: "دليل استخدام الإضافة",
            description:
                "The extension's built-in Arabic user guide. Call this whenever the user asks what the extension can do, how to use it, or about a specific tool or template — then present the returned text faithfully (it is user-facing markdown; do not summarize or paraphrase unless asked). Optional `section` narrows the guide to one top-level part: 'الكل' (default — the full guide), 'الأدوات' (all 30 tools with natural-request examples), 'القوالب' (the 7 slash templates), 'النصائح' (researcher tips). An unrecognized section value falls back to the full guide with a note. Pure text — needs no library access and never fails, so it also works when the Shamela install itself is missing. Examples: shamela_guide({}), shamela_guide({section:'القوالب'}).",
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

    // ----------- Resources (attachable catalogs/schema) -----------
    server.registerResource(
        "categories",
        "shamela://categories",
        { title: "تصنيفات المكتبة", description: "تصنيفات الشاملة الـ41 مع عدد الكتب.", mimeType: "application/json" },
        async (uri) => {
            const b = await getBackend();
            const r = runListCategories(b.catalog, listCategoriesInput.parse({ include_counts: true, response_format: "json" }));
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.structuredContent, null, 2) }] };
        },
    );
    server.registerResource(
        "downloaded",
        "shamela://downloaded",
        { title: "الكتب المنزَّلة", description: "الكتب المنزَّلة فعليًّا على هذا الجهاز (المتاحة للبحث).", mimeType: "application/json" },
        async (uri) => {
            const b = await getBackend();
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
        { title: "دليل استخدام الإضافة", description: "دليل عربي للمستخدم: الأدوات الثلاثون بأمثلة طلبات طبيعية، والقوالب السبعة، ونصائح الباحث.", mimeType: "text/markdown" },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildGuideText() }] }),
    );
    server.registerResource(
        "schema",
        "shamela://schema",
        { title: "مخطط بيانات الشاملة", description: "وصف موجز لبنية بيانات الشاملة للمطوّرين.", mimeType: "text/markdown" },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SHAMELA_SCHEMA_DOC }] }),
    );
    server.registerResource(
        "status",
        "shamela://status",
        { title: "حالة خادم الشاملة", description: "فحص ذاتي: النسخة والعدّادات وقابلية القراءة.", mimeType: "application/json" },
        async (uri) => {
            const b = await getBackend();
            const r = await runHealth(b.catalog, b.pages, healthInput.parse({ response_format: "json" }));
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.structuredContent, null, 2) }] };
        },
    );

    // ----------- Prompts (guided study workflows) -----------
    // Single source of truth: each template below must match its `text` entry
    // in manifest.json byte-for-byte, except that optional arguments carry a
    // `?? "default"` fallback here (`${madhahib ?? "الأربعة"}` in code vs
    // `${madhahib}` in the manifest). The integration suite renders every
    // prompt with sentinel arguments and compares against the manifest text,
    // and asserts each omitted-arg default, to prevent the copies drifting.

    /** Static completion lists for optional prompt arguments. */
    const MADHAHIB_COMPLETIONS = ["الأربعة", "الحنفي", "المالكي", "الشافعي", "الحنبلي"] as const;
    const QISM_COMPLETIONS = ["الكل", "الأدوات", "القوالب", "النصائح"] as const;
    const JAMIA_COMPLETIONS = [
        "جامعة الملك سعود",
        "جامعة أم القرى",
        "جامعة الإمام محمد بن سعود الإسلامية",
        "الجامعة الإسلامية بالمدينة المنورة",
        "جامعة القصيم",
        "جامعة الملك عبد العزيز",
        "جامعة طيبة",
        "جامعة الملك خالد",
    ] as const;

    /**
     * Optional prompt argument with static prefix-filtered completions.
     * The SDK (1.29) checks the completable marker in two different places
     * with different unwrapping rules: capability registration unwraps
     * ZodOptional to the inner type, while the completion/complete handler
     * inspects the field itself — so the marker must sit on BOTH layers.
     */
    function completableOptional(
        values: readonly string[],
        description: string,
    ): z.ZodOptional<z.ZodString> {
        const complete = (value?: string): string[] =>
            values.filter((v) => v.startsWith(value ?? ""));
        const inner = completable(z.string().describe(description), complete);
        return completable(inner.optional().describe(description), complete);
    }
    server.registerPrompt(
        "study_masala",
        { title: "دراسة مسألة فقهية", description: "دراسة مسألة فقهية تبدأ بتصوير المسألة ثم البحث في مظانّها.", argsSchema: { masala: z.string().describe("المسألة الفقهية المراد دراستها. مثال: حكم سجود السهو لمن شك في عدد الركعات") } },
        ({ masala }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `ادرس المسألة الفقهية: «${masala}» بأدوات المكتبة الشاملة. ابدأ بتصوير المسألة واستفصل من المستخدم عن الملابسات المؤثرة قبل البحث؛ فالحكم على الشيء فرع عن تصوره. ثم حدّد مظانّها: التصنيف المناسب من shamela_list_categories تضيّق به النطاق، والبحث بالعبارة (shamela_search_phrase) وبتوليفات الألفاظ (shamela_search_boolean)، والقراءة بالسياق عبر shamela_get_toc ثم shamela_get_book_section أو shamela_get_page. ولخّص الأقوال بأدلتها معزوًّا كلَّ قولٍ بإحالة shamela_get_citation، مميّزًا المتن من الحاشية، مصرّحًا بأن البحث مقصور على الكتب المنزّلة فلا يُعدّ غياب النتيجة نفيًا للقول.` } }],
        }),
    );
    server.registerPrompt(
        "compare_madhahib",
        { title: "مقارنة المذاهب", description: "مقارنة أقوال المذاهب الفقهية في مسألة بالبحث المتوازي في كتب كل مذهب.", argsSchema: { masala: z.string().describe("المسألة المراد مقارنة المذاهب فيها. مثال: نقض الوضوء بمس المرأة"), madhahib: completableOptional(MADHAHIB_COMPLETIONS, "نطاق المقارنة: الأربعة (الافتراضي) أو مذهب بعينه. مثال: الحنبلي") } },
        ({ masala, madhahib }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `قارن أقوال المذاهب الفقهية في: «${masala}»، والنطاق المطلوب من المذاهب: ${madhahib ?? "الأربعة"}. ابحث بحثًا متوازيًا في تصنيفات المذاهب المطلوبة كلها (تعرفها من shamela_list_categories)، وانقل عن كل مذهب من كتبه هو لا من كتب خصومه، مستعينًا بـ shamela_search_phrase وshamela_search_boolean مقيّدَين بالتصنيف. اقرأ الموضع بسياقه (shamela_get_page) وانقل القول بنصه مميّزًا المتن من الحاشية مع إحالة shamela_get_citation، ثم اجمع المقارنة في جدول: المذهب | القول | الدليل | المصدر. ولا تنسب قولًا بلا أداةٍ تثبته؛ وإن غاب مذهبٌ فصرّح بأن كتبه قد لا تكون منزّلة ولا يُعدّ ذلك نفيًا لقوله.` } }],
        }),
    );
    server.registerPrompt(
        "trace_hadith",
        { title: "تخريج حديث", description: "تخريج حديث يبدأ بتصنيف المعلوم عنه ثم تتبع مفاتيحه عبر الكتب المنزّلة.", argsSchema: { text: z.string().describe("نص الحديث أو طرفه. مثال: إنما الأعمال بالنيات") } },
        ({ text }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `خرّج الحديث: «${text}». صنّف أولًا المعلومَ عن الحديث قبل البحث (صحابيه؟ أول متنه؟ لفظة مميزة؟ موضوعه؟) فبه تتحدد طريقة البحث الأنسب. ثم ابحث بـ shamela_search_hadith عن مواضعه ومفاتيحه وتخريجه، ووسّع تتبّع كل مفتاح ظهر بـ shamela_get_books_for_hadith، وللمطابقة الحرفية للفظ المتن استعن بـ shamela_search_exact. اعرض المواضع والتخريج مع إحالة shamela_get_citation لكل موضع، ناسبًا ما في الحواشي من تخريج مطبوع (رواه فلان…) للمحقق لا للمصنّف، مصرّحًا بأن التخريج من الكتب المنزّلة فقط.` } }],
        }),
    );
    server.registerPrompt(
        "tafsir_aya_muqaran",
        { title: "مقارنة تفاسير آية", description: "جمع تفسير آية من عدة تفاسير منزّلة مرتّبةً بوفيات المفسرين.", argsSchema: { aya: z.string().describe("السورة ورقم الآية، أو نص الآية أو طرفها. مثال: البقرة 255") } },
        ({ aya }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `فسّر الآية: «${aya}» من عدة تفاسير منزّلة. حدّد الآية أولًا: إن أُعطي نصُّها فابحث بـ shamela_search_quran ثم اجلب نصها بالرسمين بـ shamela_get_aya. اعرف تغطية تفاسيرك المنزّلة لها بـ shamela_list_tafsirs_for_aya — لا تكتفِ بـ shamela_get_tafseer_of_aya ذات الفهرس المنتقى ولا تَعُدّ غياب كتابٍ دليلًا على أنه لا يفسّرها — ثم اجلب النصوص المفهرسة دفعةً واحدة بـ shamela_get_tafseer_texts. اعرض التفاسير مرتّبةً بوفيات المفسرين مع إحالة shamela_get_citation لكل نقل، مصرّحًا بأن المقارنة مقصورة على التفاسير المنزّلة.` } }],
        }),
    );
    server.registerPrompt(
        "nazila_muasira",
        { title: "دراسة نازلة معاصرة", description: "دراسة نازلة معاصرة على مراحلها الخمس من تصوير الواقع إلى الحكم.", argsSchema: { nazila: z.string().describe("النازلة المعاصرة المراد دراستها. مثال: حكم التعامل بالعملات الرقمية") } },
        ({ nazila }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `ادرس النازلة المعاصرة: «${nazila}» على المراحل الخمس: (1) تصوير الواقع: استفصل من المستخدم عن حقيقة النازلة وملابساتها؛ فالحكم على الشيء فرع عن تصوره. (2) التكييف: ألحقها ببابها الفقهي وابحث عن نظائرها في مظانّها (shamela_list_categories ثم shamela_search_phrase وshamela_search_boolean مقيّدَين بالتصنيف). (3) تحقيق المناط: تثبّت من انطباق علل الأحكام المنقولة على صورة النازلة بقراءة المواضع بسياقها (shamela_get_page مع إحالة shamela_get_citation). (4) النظر في المآلات: اعرض ما جاء في نتائج الأدوات من اعتبار المآلات والنظائر دون زيادة من عندك. (5) الحكم: اعرض خلاصة الأقوال بأدلتها منسوبةً دون ترجيح إلا بطلب المستخدم، مصرّحًا بأن البحث مقصور على الكتب المنزّلة وأن تنزيل الحكم على الواقعة مرجعه أهل الفتوى.` } }],
        }),
    );
    server.registerPrompt(
        "khittat_bahth",
        { title: "خطة بحث", description: "إعداد خطة بحث موجزة تبدأ بالتحقق من عدم سبق الدراسة.", argsSchema: { mawdu: z.string().describe("موضوع البحث المقترح. مثال: أحكام الاستصناع وتطبيقاته المعاصرة"), jamia: completableOptional(JAMIA_COMPLETIONS, "الجامعة المقدَّم إليها البحث (اختياري). مثال: جامعة القصيم") } },
        ({ mawdu, jamia }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `أعدّ خطة بحث لموضوع: «${mawdu}»، والجامعة المقصودة: ${jamia ?? "غير محددة"} (إن ذُكرت جامعة بعينها فنبّه إلى أن ضوابطها التفصيلية ستتوفر في مهارة مستقلة). تحقق أولًا من عدم سبق دراسته: ابحث بصيغ الموضوع المختلفة في فهرس الكتب بـ shamela_search_books وفي عناوين الأبواب بـ shamela_search_titles، واذكر ما وجدته من دراسات قريبة وبيّن موضع الجدة. ثم احصر مظانّ الموضوع بالتصنيفات (shamela_list_categories) وعيّن أبرز مصادره الأولية مع بيان حال تنزيلها (shamela_search_books مقيّدًا بالتصنيف). ثم اقترح عناصر الخطة موجزةً: العنوان، المشكلة، الأهمية، الدراسات السابقة، المنهج، التقسيم، قائمة المصادر — علمًا بأن تفصيل عناصر الجامعات ومعاييرها سيتوفر في مهارة قادمة.` } }],
        }),
    );
    server.registerPrompt(
        "daleel",
        { title: "دليل الاستخدام", description: "عرض دليل استخدام الإضافة كاملًا أو قسمًا منه.", argsSchema: { qism: completableOptional(QISM_COMPLETIONS, "القسم المطلوب من الدليل: الكل (الافتراضي) أو الأدوات أو القوالب أو النصائح. مثال: القوالب") } },
        ({ qism }) => ({
            messages: [{ role: "user", content: { type: "text", text:
                `استدعِ أداة shamela_guide بقسم «${qism ?? "الكل"}» واعرض ما تُرجعه كما هو منسَّقًا دون اختصارٍ ولا تصرف، ثم اقترح على المستخدم أن يسأل عن أي أداة أو قالب بمثاله.` } }],
        }),
    );

    return server;
}

/** Stdio entry point — used when this file is invoked directly. */
async function main(): Promise<void> {
    // Cache the PROMISE, not the resolved value: the warm-up below and any tool
    // call arriving during the ~12 s JVM cold start must share ONE initialization.
    // Caching the value instead would let both observe `null` and each spawn a
    // full backend (two JVMs, one leaked at shutdown, first call still slow).
    let backendPromise: Promise<Backend> | null = null;
    let backendRef: Backend | null = null; // resolved reference for shutdown()
    const getBackend = (): Promise<Backend> => {
        if (!backendPromise) {
            backendPromise = createBackend().then(
                (b) => {
                    backendRef = b;
                    return b;
                },
                (e) => {
                    backendPromise = null; // failed init must not poison later calls
                    throw e;
                },
            );
        }
        return backendPromise;
    };
    const server = createServer(getBackend);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo(`shamela-mcp v${VERSION} ready (30 tools + 5 resources + 7 prompts registered)`);

    // Cold-start fix (#14): warm the JVM + indexes right after the MCP
    // handshake (not on first tool call). Non-blocking — the handshake already
    // completed above, so a slow warm-up never trips the client's init timeout;
    // if it fails, the next tool call falls back to lazy init.
    void getBackend()
        .then(() => logInfo("backend warmed (JVM + indexes ready)"))
        .catch((e) => logInfo(`warm-up deferred to first call: ${formatErrorMessage(e)}`));

    const shutdown = () => {
        backendRef?.helper.close();
        backendRef?.pages.close();
        backendRef?.services.close();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

// Only run main() when this module is the process entry point (tsx, node dist/index.js).
// Importing it from a test must not auto-start the server.
const isEntry = ((): boolean => {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();
if (isEntry) {
    main().catch((err) => {
        process.stderr.write(`[shamela-mcp] fatal: ${formatErrorMessage(err)}\n`);
        process.exit(1);
    });
}

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
    SearchHadithOutput,
    SearchPagesOutput,
    SearchPhraseOutput,
    SearchQuranOutput,
    SearchTitlesOutput,
    SearchExactOutput,
    SearchBooleanOutput,
    RootStatsOutput,
    BooksByPeriodOutput,
    ListTafsirsForAyaOutput,
    GetTafseerTextsOutput,
    GuideOutput,
};

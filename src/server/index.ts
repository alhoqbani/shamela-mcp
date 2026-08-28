/**
 * shamela-mcp as a library — the whole public surface, in one place.
 *
 * Two hosts serve the same 34 tools: the desktop extension in `entry.ts`, and
 * the remote server that pins this repository as a dependency. Both do the
 * same three things — build an MCP server, say where Shamela lives and how to
 * read it, register the tools — and everything they need to do that is
 * exported here.
 *
 *     import { createMcpServer, registerAllTools } from "shamela-mcp";
 *
 *     const server = createMcpServer();
 *     const backend = registerAllTools(server, {
 *         resolvePaths,      // where the install is
 *         db,                // how to read its SQLite  (see ShamelaDb)
 *         createHelper,      // how to reach the search engine (see Helper)
 *     });
 *     await server.connect(transport);
 *
 * Note what is NOT here: sql.js. The extension's SQLite implementation lives
 * behind its own entry point (`shamela-mcp/sqljs`) so that a host with a
 * native driver never loads a WebAssembly build of SQLite it has no use for.
 */

// --- Registering the tools --------------------------------------------------

export { createMcpServer, createServer, registerAllTools } from "./register.js";

// --- The environment a host injects -----------------------------------------

export {
    createBackend,
    createBackendProvider,
    createPartialBackend,
    logInfo,
    readyTimeoutMs,
    type Backend,
    type BackendProvider,
    type PartialBackend,
    type ShamelaDeps,
} from "./backend.js";

export type { ShamelaDb, SqlDatabase, SqlStatement, SqlValue } from "./db.js";

export {
    HelperError,
    JavaHelper,
    type Helper,
    type HelperConfig,
    type HelperInfo,
} from "./helper.js";

export { resolveAll, type ShamelaPaths } from "./paths.js";

// --- Errors a host may want to recognise ------------------------------------

export { ShamelaError, errorCode, formatErrorMessage, type ErrorCode } from "./errors.js";
export { ShamelaNotFoundError } from "./paths.js";

// --- Server identity --------------------------------------------------------

export { VERSION } from "./constants.js";

// --- The pieces the backend is made of --------------------------------------

export { Catalog, CatalogScope } from "./catalog.js";
export { CatalogFreshness } from "./freshness.js";
export { PageStore } from "./pages.js";
export { ServiceStore } from "./services.js";
export { AyaIndexStore } from "./ayaIndex/store.js";

// --- Tool output shapes -----------------------------------------------------

export type { GetAuthorOutput } from "./tools/getAuthor.js";
export type { GetAyaOutput } from "./tools/getAya.js";
export type { GetBookOutput } from "./tools/getBook.js";
export type { GetBookPartsOutput } from "./tools/getBookParts.js";
export type { GetBookSectionOutput } from "./tools/getBookSection.js";
export type { GetBooksForHadithOutput } from "./tools/getBooksForHadith.js";
export type { GetCitationOutput } from "./tools/getCitation.js";
export type { GetPageOutput } from "./tools/getPage.js";
export type { GetPageServicesOutput } from "./tools/getPageServices.js";
export type { GetPagesRangeOutput } from "./tools/getPagesRange.js";
export type { GetTafseerOfAyaOutput } from "./tools/getTafseerOfAya.js";
export type { GetTocOutput } from "./tools/getToc.js";
export type { ListCategoriesOutput } from "./tools/listCategories.js";
export type { ListDownloadedBooksOutput } from "./tools/listDownloadedBooks.js";
export type { ResolveOutput } from "./tools/resolve.js";
export type { SearchAuthorsOutput } from "./tools/searchAuthors.js";
export type { SearchBooksOutput } from "./tools/searchBooks.js";
export type { SearchHadithOutput } from "./tools/searchHadith.js";
export type { SearchPagesOutput } from "./tools/searchPages.js";
export type { SearchPhraseOutput } from "./tools/searchPhrase.js";
export type { SearchQuranOutput } from "./tools/searchQuran.js";
export type { SearchTitlesOutput } from "./tools/searchTitles.js";
export type { SearchExactOutput } from "./tools/searchExact.js";
export type { SearchBooleanOutput } from "./tools/searchBoolean.js";
export type { RootStatsOutput } from "./tools/rootStats.js";
export type { BooksByPeriodOutput } from "./tools/booksByPeriod.js";
export type { ListTafsirsForAyaOutput } from "./tools/listTafsirsForAya.js";
export type { GetTafseerTextsOutput } from "./tools/getTafseerTexts.js";
export type { GuideOutput } from "./tools/guide.js";
export type { VerifyQuoteOutput } from "./tools/verifyQuote.js";
export type { ScanConsensusOutput } from "./tools/scanConsensus.js";
export type { ResearchScopeOutput } from "./tools/researchScope.js";

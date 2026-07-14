/**
 * Shared constants. Per `docs/architecture.md` and the mcp-builder Node guide.
 */

export const VERSION = "1.2.0";

/** Maximum response size in characters before truncation. mcp-builder default. */
export const CHARACTER_LIMIT = 25_000;

/** Default `limit` for paginated tools. */
export const DEFAULT_LIMIT = 20;

/** Maximum `limit` accepted by paginated tools. */
export const MAX_LIMIT = 100;

/** Cap for coverage aggregation on the Java side (per architecture). */
export const COVERAGE_CAP = 5_000;

/** Snippet window in characters around the first match. */
export const SNIPPET_WINDOW = 80;

/** get_page: split a single page body into parts once it exceeds this many chars
 *  (long-text pagination — see issue #16). */
export const PAGE_BODY_BUDGET = 4_000;

/** Multi-page reads (get_pages_range / get_book_section): stop adding pages once
 *  cumulative body+foot characters exceed this, so long sections don't dump. */
export const MULTIPAGE_CHAR_BUDGET = 12_000;

/** LRU cache size for per-book SQLite handles. */
export const PER_BOOK_CACHE_LIMIT = 50;

/** Total verses in the Qur'an. Used for AYA_NOT_FOUND validation. */
export const QURAN_AYA_COUNT = 6236;

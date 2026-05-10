import { z } from "zod";

import { CatalogScope, type Catalog } from "../catalog.js";
import { emptyScope } from "../errors.js";
import type { Helper } from "../helper.js";
import type { PageStore } from "../pages.js";
import {
    OptionsInputShape,
    PaginationInput,
    ResponseFormatInput,
    ScopeInputShape,
    type ScopeInputType,
} from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const searchPagesInputShape = {
    query: z.string().min(1).describe("Arabic search phrase. Multiple words are AND-combined; each can match in body or footnotes."),
    scope: z.object(ScopeInputShape).strict().optional().describe("Restrict the search to specific books, authors, categories, or a Hijri date range. Use shamela_list_categories / shamela_resolve to find IDs."),
    options: z.object(OptionsInputShape).strict().optional().describe("Search options: morphology, wildcards, search_in (body/foot/comment), preserve_*. Defaults to body+foot, no toggles."),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const searchPagesInput = z.object(searchPagesInputShape).strict();

interface RawHit {
    book_id: number;
    page_id: number;
    matched_in: string[];
    snippet_body: string;
    snippet_foot: string;
    snippet_comment?: string;
}
interface RawCoverage {
    by_book_key: Record<string, number>;
    total_seen: number;
    at_cap: boolean;
}
interface RawEnvelope {
    query: string;
    normalized_tokens: string[];
    offset: number;
    total_hits: number;
    returned: number;
    has_more: boolean;
    next_offset?: number;
    scope_count: number;
    coverage: RawCoverage;
    results: RawHit[];
}

export interface SearchPageHit {
    book_id: number;
    book_name: string;
    author_name: string | null;
    category: string | null;
    book_date: number | null;
    page_id: number;
    printed_page: string | null;
    matched_in: string[];
    snippet_body: string;
    snippet_foot: string;
    snippet_comment?: string;
}

export interface SearchPagesOutput {
    total_hits: number;
    returned: number;
    offset: number;
    has_more: boolean;
    next_offset?: number;
    query: string;
    normalized_tokens: string[];
    scope_count: number;
    coverage: {
        by_category: Record<string, number>;
        by_century: Record<string, number>;
        by_book: Record<string, number>;
        by_author: Record<string, number>;
    };
    results: SearchPageHit[];
}

export async function runSearchPages(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof searchPagesInput>,
): Promise<RenderedResponse<SearchPagesOutput>> {
    let scopeBookKeys: string[] | null = null;
    let scopeCount = -1;
    if (args.scope) {
        const scopeInput: ScopeInputType = {
            ...(args.scope as ScopeInputType),
            downloaded_only: args.scope?.downloaded_only ?? false,
        };
        const resolved = new CatalogScope(catalog).resolveBookIds(scopeInput);
        if (resolved.book_ids.length === 0) throw emptyScope(resolved.diagnostics);
        scopeBookKeys = resolved.book_ids.map(String);
        scopeCount = resolved.book_ids.length;
    }

    const raw = await helper.request<RawEnvelope>("search_pages", {
        query: args.query,
        scope_book_keys: scopeBookKeys,
        max_results: args.limit,
        offset: args.offset,
        options: args.options ?? {},
    });

    const enriched: SearchPageHit[] = [];
    for (const hit of raw.results) {
        const rec = catalog.bookRecord(hit.book_id);
        const printed = await pages.printedPage(hit.book_id, hit.page_id);
        enriched.push({
            book_id: hit.book_id,
            book_name: rec?.book_name ?? `(unknown ${hit.book_id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            category: rec ? catalog.categoryPath(rec.book_category)[0] ?? null : null,
            book_date: rec?.book_date ?? null,
            page_id: hit.page_id,
            printed_page: printed,
            matched_in: hit.matched_in,
            snippet_body: hit.snippet_body,
            snippet_foot: hit.snippet_foot,
            ...(hit.snippet_comment ? { snippet_comment: hit.snippet_comment } : {}),
        });
    }

    const coverage = enrichCoverage(raw.coverage, catalog);
    const out: SearchPagesOutput = {
        total_hits: raw.total_hits,
        returned: raw.returned,
        offset: raw.offset,
        has_more: raw.has_more,
        ...(raw.next_offset !== undefined ? { next_offset: raw.next_offset } : {}),
        query: raw.query,
        normalized_tokens: raw.normalized_tokens,
        scope_count: scopeCount,
        coverage,
        results: enriched,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [header(1, `نتائج البحث في الصفحات: «${data.query}»`)];
        lines.push(
            `**${arabize(data.total_hits)}** صفحة موافقة، عرض ${arabize(data.returned)} ابتداءً من ${arabize(data.offset)}.`,
        );
        if (data.scope_count >= 0) lines.push(`النطاق: ${arabize(data.scope_count)} كتاب.`);
        lines.push("");
        for (const r of data.results) {
            lines.push(
                `## ${r.book_name}${r.printed_page ? ` (ص ${arabize(r.printed_page)})` : ""} — page_id=${r.page_id}`,
            );
            if (r.author_name) lines.push(`*${r.author_name}*${r.book_date ? ` — ${arabize(r.book_date)}هـ` : ""}`);
            if (r.snippet_body) lines.push("", `> ${r.snippet_body}`);
            if (r.snippet_foot) lines.push("", `> _حاشية_: ${r.snippet_foot}`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        return lines.join("\n");
    });
}

function enrichCoverage(raw: RawCoverage, catalog: Catalog) {
    const byCat: Record<string, number> = {};
    const byCentury: Record<string, number> = {};
    const byBook: Record<string, number> = {};
    const byAuthor: Record<string, number> = {};
    const items = Object.entries(raw.by_book_key);
    items.sort((a, b) => b[1] - a[1]);
    let bookCnt = 0;
    let authorCnt = 0;
    for (const [key, count] of items) {
        const id = parseInt(key, 10);
        if (Number.isNaN(id)) continue;
        const rec = catalog.bookRecord(id);
        if (!rec) continue;
        const catName = catalog.categoryPath(rec.book_category)[0];
        if (catName) byCat[catName] = (byCat[catName] ?? 0) + count;
        if (rec.book_date) {
            const cen = String(Math.floor((rec.book_date - 1) / 100) + 1);
            byCentury[cen] = (byCentury[cen] ?? 0) + count;
        }
        if (bookCnt < 10) {
            byBook[rec.book_name] = count;
            bookCnt++;
        }
        const author = catalog.mainAuthorName(rec);
        if (author && authorCnt < 10) {
            byAuthor[author] = (byAuthor[author] ?? 0) + count;
            authorCnt++;
        }
    }
    return {
        by_category: byCat,
        by_century: byCentury,
        by_book: byBook,
        by_author: byAuthor,
    };
}

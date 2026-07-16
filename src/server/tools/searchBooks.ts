import { z } from "zod";

import { CatalogScope, type Catalog } from "../catalog.js";
import { emptyScope } from "../errors.js";
import type { Helper } from "../helper.js";
import {
    OptionsInputShape,
    PaginationInput,
    ResponseFormatInput,
    ScopeInputShape,
    type ScopeInputType,
} from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";
import { UNDATED_BOOK_DATE, UNDATED_CENTURY_LABEL } from "../constants.js";

// scope.book_ids isn't useful when searching the catalog; expose the rest.
const SearchBooksScopeShape = {
    author_ids: ScopeInputShape.author_ids,
    category_ids: ScopeInputShape.category_ids,
    period_from: ScopeInputShape.period_from,
    period_to: ScopeInputShape.period_to,
    downloaded_only: ScopeInputShape.downloaded_only,
};

export const searchBooksInputShape = {
    query: z.string().min(1).describe("Arabic search phrase matched against the book name + author + bibliography concatenation."),
    scope: z.object(SearchBooksScopeShape).strict().optional().describe("Optional: restrict to specific authors, categories, periods, or downloaded-only."),
    options: z.object(OptionsInputShape).strict().optional().describe("morphology / wildcards / preserve_*."),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const searchBooksInput = z.object(searchBooksInputShape).strict();

interface RawHit { book_id: number; snippet: string; }
interface RawEnvelope {
    query: string; normalized_tokens: string[]; offset: number;
    total_hits: number; returned: number; has_more: boolean; next_offset?: number;
    coverage: { by_book_key: Record<string, number>; total_seen: number };
    results: RawHit[];
}

export interface SearchBookHit {
    book_id: number;
    book_name: string;
    author_name: string | null;
    category: string | null;
    book_date: number | null;
    downloaded: boolean;
    snippet: string;
}

export interface SearchBooksOutput {
    total_hits: number; returned: number; offset: number;
    has_more: boolean; next_offset?: number;
    query: string; normalized_tokens: string[];
    coverage: { by_category: Record<string, number>; by_century: Record<string, number> };
    results: SearchBookHit[];
}

export async function runSearchBooks(
    helper: Helper,
    catalog: Catalog,
    args: z.infer<typeof searchBooksInput>,
): Promise<RenderedResponse<SearchBooksOutput>> {
    let scopeBookKeys: string[] | null = null;
    if (args.scope) {
        const scopeInput: ScopeInputType = {
            ...(args.scope as ScopeInputType),
            downloaded_only: args.scope?.downloaded_only ?? false,
        };
        const resolved = new CatalogScope(catalog).resolveBookIds(scopeInput);
        if (resolved.book_ids.length === 0) throw emptyScope(resolved.diagnostics);
        scopeBookKeys = resolved.book_ids.map(String);
    }
    // Bug #2 workaround: SearchBooks.java applies scope only as a post-fetch
    // filter on `results`, so the helper's `total_hits` / `has_more` /
    // `next_offset` are pre-scope and wrong. When scope is provided we
    // overfetch (helper caps at 5000), trust the scope-filtered `results`
    // array, and re-derive pagination here. Proper fix is in SearchBooks.java —
    // pass scopeBookKeys to QueryBuilder.build using the `id` field — but that
    // needs a JDK to rebuild the helper jar.
    const isScoped = scopeBookKeys !== null;
    const HELPER_FETCH_CAP = 5000;
    const raw = await helper.request<RawEnvelope>("search_books", {
        query: args.query,
        scope_book_keys: scopeBookKeys,
        max_results: isScoped ? HELPER_FETCH_CAP : args.limit,
        offset: isScoped ? 0 : args.offset,
        options: args.options ?? {},
    });
    if (isScoped) {
        const all = raw.results;
        const start = args.offset;
        const end = start + args.limit;
        const slice = all.slice(start, end);
        raw.results = slice;
        raw.total_hits = all.length;
        raw.returned = slice.length;
        raw.offset = start;
        raw.has_more = end < all.length;
        raw.next_offset = raw.has_more ? end : undefined;
    }
    const byCat: Record<string, number> = {};
    const byCentury: Record<string, number> = {};
    const items = Object.entries(raw.coverage.by_book_key).sort((a, b) => b[1] - a[1]);
    for (const [k, c] of items) {
        const id = parseInt(k, 10);
        const rec = !Number.isNaN(id) ? catalog.bookRecord(id) : undefined;
        if (!rec) continue;
        const catName = catalog.categoryPath(rec.book_category)[0];
        if (catName) byCat[catName] = (byCat[catName] ?? 0) + c;
        if (rec.book_date && rec.book_date !== UNDATED_BOOK_DATE) {
            const cen = String(Math.floor((rec.book_date - 1) / 100) + 1);
            byCentury[cen] = (byCentury[cen] ?? 0) + c;
        } else {
            byCentury[UNDATED_CENTURY_LABEL] = (byCentury[UNDATED_CENTURY_LABEL] ?? 0) + c;
        }
    }
    const results: SearchBookHit[] = raw.results.map((h) => {
        const rec = catalog.bookRecord(h.book_id);
        return {
            book_id: h.book_id,
            book_name: rec?.book_name ?? `(unknown ${h.book_id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            category: rec ? catalog.categoryPath(rec.book_category)[0] ?? null : null,
            book_date: rec?.book_date ?? null,
            downloaded: rec ? rec.major_ondisk > 0 : false,
            snippet: h.snippet,
        };
    });
    const out: SearchBooksOutput = {
        total_hits: raw.total_hits, returned: raw.returned, offset: raw.offset,
        has_more: raw.has_more,
        ...(raw.next_offset !== undefined ? { next_offset: raw.next_offset } : {}),
        query: raw.query, normalized_tokens: raw.normalized_tokens,
        coverage: { by_category: byCat, by_century: byCentury },
        results,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [header(1, `نتائج البحث في فهرس الكتب: «${data.query}»`)];
        lines.push(`**${arabize(data.total_hits)}** كتاب موافق، عرض ${arabize(data.returned)}.`);
        lines.push("");
        for (const r of data.results) {
            lines.push(`## ${r.book_name} (id=${r.book_id})${r.downloaded ? " — منزَّل" : ""}`);
            if (r.author_name) lines.push(`*${r.author_name}*${r.book_date ? ` — ${arabize(r.book_date)}هـ` : ""}`);
            if (r.category) lines.push(`التصنيف: ${r.category}`);
            if (r.snippet) lines.push("", `> ${r.snippet}`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        return lines.join("\n");
    });
}

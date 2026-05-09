import { z } from "zod";

import type { Catalog } from "../catalog.js";
import type { Helper } from "../helper.js";
import type { PageStore } from "../pages.js";

export const searchPagesInput = {
    query: z.string().describe("Arabic search phrase. Multiple words are AND-combined."),
    max_results: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of hits to return (1-100, default 20)."),
};

interface RawHit {
    book_id: number;
    page_id: number;
    matched_in: string[];
    snippet_body: string;
    snippet_foot: string;
}

interface RawEnvelope {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: RawHit[];
}

export interface SearchPageHit extends RawHit {
    book_name: string;
    author_name: string | null;
    printed_page: string | null;
}

export interface SearchPagesOutput {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: SearchPageHit[];
}

export async function searchPages(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: { query: string; max_results: number },
): Promise<SearchPagesOutput> {
    const raw = await helper.request<RawEnvelope>("search_pages", args);
    const enriched: SearchPageHit[] = [];
    for (const hit of raw.results) {
        const book = catalog.book(hit.book_id);
        const printed = await pages.printedPage(hit.book_id, hit.page_id);
        enriched.push({
            book_id: hit.book_id,
            page_id: hit.page_id,
            book_name: book.book_name,
            author_name: book.author_name,
            printed_page: printed,
            matched_in: hit.matched_in,
            snippet_body: hit.snippet_body,
            snippet_foot: hit.snippet_foot,
        });
    }
    return {
        total_hits: raw.total_hits,
        returned: raw.returned,
        query: raw.query,
        normalized_tokens: raw.normalized_tokens,
        results: enriched,
    };
}

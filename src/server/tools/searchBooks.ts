import { z } from "zod";

import type { Catalog } from "../catalog.js";
import type { Helper } from "../helper.js";

export const searchBooksInput = {
    query: z.string().describe("Arabic search phrase, matched against book name + author + bibliography."),
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
    snippet: string;
}

interface RawEnvelope {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: RawHit[];
}

export interface SearchBookHit {
    book_id: number;
    book_name: string;
    author_name: string | null;
    snippet: string;
}

export interface SearchBooksOutput {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: SearchBookHit[];
}

export async function searchBooks(
    helper: Helper,
    catalog: Catalog,
    args: { query: string; max_results: number },
): Promise<SearchBooksOutput> {
    const raw = await helper.request<RawEnvelope>("search_books", args);
    const enriched: SearchBookHit[] = raw.results.map((hit) => {
        const book = catalog.book(hit.book_id);
        return {
            book_id: hit.book_id,
            book_name: book.book_name,
            author_name: book.author_name,
            snippet: hit.snippet,
        };
    });
    return {
        total_hits: raw.total_hits,
        returned: raw.returned,
        query: raw.query,
        normalized_tokens: raw.normalized_tokens,
        results: enriched,
    };
}

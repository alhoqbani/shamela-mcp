import { z } from "zod";

import type { Catalog } from "../catalog.js";
import type { Helper } from "../helper.js";

export const searchAuthorsInput = {
    query: z.string().describe("Arabic search phrase, matched against author name + biography."),
    max_results: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of hits to return (1-100, default 20)."),
};

interface RawHit {
    author_id: number;
    snippet: string;
}

interface RawEnvelope {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: RawHit[];
}

export interface SearchAuthorHit {
    author_id: number;
    author_name: string;
    death_year: number | null;
    snippet: string;
}

export interface SearchAuthorsOutput {
    total_hits: number;
    returned: number;
    query: string;
    normalized_tokens: string[];
    results: SearchAuthorHit[];
}

export async function searchAuthors(
    helper: Helper,
    catalog: Catalog,
    args: { query: string; max_results: number },
): Promise<SearchAuthorsOutput> {
    const raw = await helper.request<RawEnvelope>("search_authors", args);
    const enriched: SearchAuthorHit[] = raw.results.map((hit) => {
        const author = catalog.author(hit.author_id);
        return {
            author_id: hit.author_id,
            author_name: author.author_name,
            death_year: author.death_year,
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

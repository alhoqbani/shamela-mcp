import { z } from "zod";

import type { Catalog } from "../catalog.js";
import type { Helper } from "../helper.js";
import { OptionsInputShape, PaginationInput, ResponseFormatInput } from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const searchAuthorsInputShape = {
    query: z.string().min(1).describe("Arabic search phrase matched against author name + biography."),
    options: z.object(OptionsInputShape).strict().optional().describe("morphology / wildcards. No scope (authors aren't scoped by category/period)."),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const searchAuthorsInput = z.object(searchAuthorsInputShape).strict();

interface RawHit { author_id: number; snippet: string; }
interface RawEnvelope {
    query: string; normalized_tokens: string[]; offset: number;
    total_hits: number; returned: number; has_more: boolean; next_offset?: number;
    results: RawHit[];
}

export interface SearchAuthorHit {
    author_id: number;
    author_name: string;
    death_year: number | null;
    book_count: number;
    snippet: string;
}

export interface SearchAuthorsOutput {
    total_hits: number; returned: number; offset: number;
    has_more: boolean; next_offset?: number;
    query: string; normalized_tokens: string[];
    results: SearchAuthorHit[];
}

export async function runSearchAuthors(
    helper: Helper,
    catalog: Catalog,
    args: z.infer<typeof searchAuthorsInput>,
): Promise<RenderedResponse<SearchAuthorsOutput>> {
    const raw = await helper.request<RawEnvelope>("search_authors", {
        query: args.query,
        max_results: args.limit,
        offset: args.offset,
        options: args.options ?? {},
    });
    const results: SearchAuthorHit[] = raw.results.map((h) => {
        const rec = catalog.authorRecord(h.author_id);
        return {
            author_id: h.author_id,
            author_name: rec?.author_name ?? `(unknown ${h.author_id})`,
            death_year: rec?.death_year ?? null,
            book_count: catalog.booksByAuthorId(h.author_id).length,
            snippet: h.snippet,
        };
    });
    const out: SearchAuthorsOutput = {
        total_hits: raw.total_hits, returned: raw.returned, offset: raw.offset,
        has_more: raw.has_more,
        ...(raw.next_offset !== undefined ? { next_offset: raw.next_offset } : {}),
        query: raw.query, normalized_tokens: raw.normalized_tokens,
        results,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [header(1, `نتائج البحث في فهرس المؤلفين: «${data.query}»`)];
        lines.push(`**${arabize(data.total_hits)}** مؤلف موافق، عرض ${arabize(data.returned)}.`);
        lines.push("");
        for (const r of data.results) {
            lines.push(`## ${r.author_name}${r.death_year ? ` (ت ${arabize(r.death_year)}هـ)` : ""}`);
            lines.push(`id=${r.author_id} — ${arabize(r.book_count)} كتاب`);
            if (r.snippet) lines.push("", `> ${r.snippet}`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        return lines.join("\n");
    });
}

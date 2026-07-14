/**
 * shamela_search_phrase (#19) — exact-phrase and proximity search.
 *
 * The Lucene index AND-combines tokens but exposes no phrase/proximity query
 * through the helper. This tool implements both with a two-stage strategy that
 * needs no Java change:
 *   1. Ask the helper for pages where ALL query words occur (candidate set).
 *   2. Fetch each candidate's full text and keep only pages where the words are
 *      actually adjacent (phrase) or within `distance` words (near), checked in
 *      Node against the same normalization used everywhere else.
 *
 * This is the Node-only prototype of proposal #1 (advanced search) layered on
 * proposal #2's two-stage verification pattern.
 */

import { z } from "zod";

import { containsPhrase, tokenizeArabic, withinProximity } from "../arabic.js";
import { CatalogScope, type Catalog } from "../catalog.js";
import { badArg, emptyScope } from "../errors.js";
import type { Helper } from "../helper.js";
import type { PageStore } from "../pages.js";
import { PaginationInput, ResponseFormatInput, ScopeInputShape, type ScopeInputType } from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const searchPhraseInputShape = {
    query: z
        .string()
        .min(1)
        .describe(
            "Arabic phrase. In mode='phrase' the words must appear consecutively (exact phrase). In mode='near' the words must appear within `distance` words of each other in any order.",
        ),
    mode: z
        .enum(["phrase", "near"])
        .default("phrase")
        .describe("'phrase' = exact consecutive words (default). 'near' = words within `distance` words, any order."),
    distance: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe("For mode='near': maximum number of words between the query words. Ignored for mode='phrase'."),
    search_in: z
        .array(z.enum(["body", "foot", "comment"]))
        .default(["body", "foot"])
        .describe("Which page sections to verify the phrase in: body (matn), foot (footnotes), comment."),
    scope: z
        .object(ScopeInputShape)
        .strict()
        .optional()
        .describe("Restrict to books/authors/categories/period. Strongly recommended to scope large libraries."),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const searchPhraseInput = z.object(searchPhraseInputShape).strict();

interface RawHit {
    book_id: number;
    page_id: number;
    matched_in: string[];
    snippet_body: string;
    snippet_foot: string;
    snippet_comment?: string;
}
interface RawEnvelope {
    total_hits: number;
    returned: number;
    has_more: boolean;
    results: RawHit[];
}
interface BatchPage {
    page_id: number;
    found: boolean;
    body: string;
    foot: string;
    comment: string;
}
interface BatchEnvelope {
    book_id: number;
    results: BatchPage[];
}

export interface PhraseHit {
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
}

export interface SearchPhraseOutput {
    mode: "phrase" | "near";
    query: string;
    distance: number;
    total_candidates_scanned: number;
    candidate_cap_hit: boolean;
    returned: number;
    results: PhraseHit[];
}

export async function runSearchPhrase(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof searchPhraseInput>,
): Promise<RenderedResponse<SearchPhraseOutput>> {
    const qTokens = tokenizeArabic(args.query);
    if (qTokens.length === 0) throw badArg("Query has no searchable Arabic words.");

    // Resolve scope to book keys (same path as search_pages).
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

    // Stage 1: candidate pages where all words co-occur.
    const candidateCap = Math.min(Math.max(args.limit * 8, 40), 100);
    const raw = await helper.request<RawEnvelope>("search_pages", {
        query: args.query,
        scope_book_keys: scopeBookKeys,
        max_results: candidateCap,
        offset: 0,
        options: { search_in: args.search_in },
    });
    const candidates = raw.results;
    const candidateCapHit = raw.has_more || raw.total_hits > candidates.length;

    // Fetch full text for candidates, grouped by book (one batch per book).
    const byBook = new Map<number, number[]>();
    for (const c of candidates) {
        const list = byBook.get(c.book_id) ?? [];
        list.push(c.page_id);
        byBook.set(c.book_id, list);
    }
    const text = new Map<string, BatchPage>();
    for (const [bookId, pageIds] of byBook) {
        const batch = await helper.request<BatchEnvelope>("get_pages_batch", {
            book_id: bookId,
            page_ids: pageIds,
        });
        for (const p of batch.results) text.set(`${bookId}:${p.page_id}`, p);
    }

    // Stage 2: keep only pages where the words are actually adjacent / near.
    const fields = args.search_in;
    const results: PhraseHit[] = [];
    for (const c of candidates) {
        if (results.length >= args.limit) break;
        const page = text.get(`${c.book_id}:${c.page_id}`);
        if (!page || !page.found) continue;

        const matchedFields: string[] = [];
        for (const f of fields) {
            const fieldText = f === "body" ? page.body : f === "foot" ? page.foot : page.comment;
            if (!fieldText) continue;
            const hayTokens = tokenizeArabic(fieldText);
            const ok =
                args.mode === "phrase"
                    ? containsPhrase(hayTokens, qTokens)
                    : withinProximity(hayTokens, qTokens, args.distance);
            if (ok) matchedFields.push(f);
        }
        if (matchedFields.length === 0) continue;

        const rec = catalog.bookRecord(c.book_id);
        const printed = await pages.printedPage(c.book_id, c.page_id);
        results.push({
            book_id: c.book_id,
            book_name: rec?.book_name ?? `(unknown ${c.book_id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            category: rec ? catalog.categoryPath(rec.book_category)[0] ?? null : null,
            book_date: rec?.book_date ?? null,
            page_id: c.page_id,
            printed_page: printed,
            matched_in: matchedFields,
            snippet_body: c.snippet_body,
            snippet_foot: c.snippet_foot,
        });
    }

    const out: SearchPhraseOutput = {
        mode: args.mode,
        query: args.query,
        distance: args.distance,
        total_candidates_scanned: candidates.length,
        candidate_cap_hit: candidateCapHit,
        returned: results.length,
        results,
    };

    return renderResponse(out, args.response_format, (data) => {
        const lines = [
            header(
                1,
                data.mode === "phrase"
                    ? `بحث بالعبارة الحرفية: «${data.query}»`
                    : `بحث بالتقارب اللفظي (ضمن ${arabize(data.distance)} كلمات): «${data.query}»`,
            ),
        ];
        lines.push(
            `**${arabize(data.returned)}** صفحة مطابقة (من ${arabize(data.total_candidates_scanned)} صفحة مرشَّحة فُحصت).`,
        );
        if (data.candidate_cap_hit) {
            lines.push(
                "*ملاحظة: عدد الصفحات المرشَّحة تجاوز سقف الفحص؛ ضيِّق النطاق (scope) لتغطية أشمل.*",
            );
        }
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
        return lines.join("\n");
    });
}

/**
 * shamela_search_boolean (#19) — boolean search with OR and NOT.
 *
 * The regular `shamela_search_pages` AND-combines all query tokens and offers no
 * OR (any-of) or NOT (exclusion) operators. This tool adds both, with no Java
 * change, by orchestrating several AND-searches in Node and doing the set
 * algebra on the returned hit identifiers (book_id + page_id):
 *
 *   candidate = ( ∩ over all_of[i] of results(all_of[i]) )   // AND across all_of
 *                   ∩ ( ∪ over any_of[j] of results(any_of[j]) )   // OR across any_of
 *   result    = candidate \ ( ∪ over none_of[k] of results(none_of[k]) )   // NOT
 *
 * Each sub-search is one call to the helper's existing AND-search primitive
 * (the same `search_pages` command `runSearchPages` uses). Every term is passed
 * as its own query so its per-term hit set can be intersected / unioned /
 * subtracted independently.
 *
 * QUALITY-FIRST + HONESTY: each sub-search returns a CAPPED window of hits (the
 * index does not stream every match), so the set algebra runs over a candidate
 * *window*, not the whole library. This is best-effort by construction:
 *   - `candidate_cap_hit` is true when ANY contributing sub-search hit its cap
 *     (its real total exceeded the window we could see).
 *   - `none_of_within_window` is true when any exclusion term hit its cap — the
 *     NOT could only be applied inside the window, so a page excluded by an
 *     unseen none_of hit may still slip through. We say so in the notes.
 *   - per-subquery counts (`subqueries[]`) expose exactly how many hits each
 *     term contributed and whether it was capped.
 * The tool STRONGLY encourages `scope`; for a large library, an unscoped
 * boolean search is unreliable and the notes flag that too.
 *
 * This is the Node-only prototype of proposal #1 (advanced/boolean search),
 * built on the same candidate-window pattern as `shamela_search_phrase`.
 */

import { z } from "zod";

import { CatalogScope, type Catalog } from "../catalog.js";
import { badArg, emptyScope } from "../errors.js";
import type { Helper } from "../helper.js";
import type { PageStore } from "../pages.js";
import { PaginationInput, ResponseFormatInput, ScopeInputShape, type ScopeInputType } from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const searchBooleanInputShape = {
    all_of: z
        .array(z.string().min(1))
        .default([])
        .describe(
            "AND — terms that must ALL appear on the page (each term is itself AND-searched, so a multi-word term must co-occur). Intersection of every term's hit set. Leave empty to rely on any_of.",
        ),
    any_of: z
        .array(z.string().min(1))
        .default([])
        .describe(
            "OR — at least ONE of these terms must appear on the page. Union of every term's hit set, then intersected with the all_of result. Leave empty to rely on all_of.",
        ),
    none_of: z
        .array(z.string().min(1))
        .default([])
        .describe(
            "NOT — pages containing ANY of these terms are excluded. Applied within the returned candidate window (see none_of_within_window in the output). Optional.",
        ),
    scope: z
        .object(ScopeInputShape)
        .strict()
        .optional()
        .describe(
            "Restrict to books/authors/categories/period. STRONGLY recommended: an unscoped boolean search over a large downloaded library only sees a capped window per term and is best-effort. Use shamela_list_categories / shamela_resolve to find IDs.",
        ),
    search_in: z
        .array(z.enum(["body", "foot", "comment"]))
        .default(["body", "foot"])
        .describe("Which page sections each sub-search looks in: body (matn), foot (footnotes), comment. Default ['body','foot']."),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const searchBooleanInput = z.object(searchBooleanInputShape).strict();

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

/** Result of one per-term AND-sub-search, kept so we can do set algebra + honesty. */
interface SubSearch {
    term: string;
    role: "all_of" | "any_of" | "none_of";
    total_hits: number;
    returned: number;
    cap_hit: boolean;
    hits: Map<string, RawHit>; // key = "book_id:page_id"
}

export interface SubqueryReport {
    term: string;
    role: "all_of" | "any_of" | "none_of";
    total_hits: number;
    window_returned: number;
    cap_hit: boolean;
}

export interface BooleanHit {
    book_id: number;
    book_name: string;
    author_name: string | null;
    category: string | null;
    book_date: number | null;
    page_id: number;
    printed_page: string | null;
    matched_in: string[];
    /** Which all_of/any_of terms this page's window hit came from. */
    matched_terms: string[];
    snippet_body: string;
    snippet_foot: string;
    snippet_comment?: string;
}

export interface SearchBooleanOutput {
    all_of: string[];
    any_of: string[];
    none_of: string[];
    scope_count: number;
    /** Pages surviving the boolean algebra within the candidate window, before pagination. */
    total_in_window: number;
    returned: number;
    offset: number;
    has_more: boolean;
    next_offset?: number;
    /** True when any contributing sub-search hit its per-term window cap. */
    candidate_cap_hit: boolean;
    /** True when a none_of term hit its cap: exclusion is window-only, not exhaustive. */
    none_of_within_window: boolean;
    subqueries: SubqueryReport[];
    notes: string[];
    results: BooleanHit[];
}

const key = (h: { book_id: number; page_id: number }): string => `${h.book_id}:${h.page_id}`;

export async function runSearchBoolean(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof searchBooleanInput>,
): Promise<RenderedResponse<SearchBooleanOutput>> {
    const allOf = args.all_of ?? [];
    const anyOf = args.any_of ?? [];
    const noneOf = args.none_of ?? [];

    if (allOf.length === 0 && anyOf.length === 0) {
        throw badArg("At least one of `all_of` or `any_of` must contain a term.");
    }

    // Resolve scope to book keys (same path as search_pages / search_phrase).
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

    // Per-term window cap. Same spirit as search_phrase: scale with the page
    // budget but bounded so a single term can't drown the candidate window.
    // A wider cap here than the requested `limit` because the intersection can
    // discard most of each term's hits before pagination.
    const perTermCap = Math.min(Math.max(args.limit * 8, 60), 200);

    // Run every term (all roles) as its own AND-sub-search, in parallel.
    const specs: Array<{ term: string; role: SubSearch["role"] }> = [
        ...allOf.map((term) => ({ term, role: "all_of" as const })),
        ...anyOf.map((term) => ({ term, role: "any_of" as const })),
        ...noneOf.map((term) => ({ term, role: "none_of" as const })),
    ];

    const subs: SubSearch[] = await Promise.all(
        specs.map(async ({ term, role }) => {
            const raw = await helper.request<RawEnvelope>("search_pages", {
                query: term,
                scope_book_keys: scopeBookKeys,
                max_results: perTermCap,
                offset: 0,
                options: { search_in: args.search_in },
            });
            const hits = new Map<string, RawHit>();
            for (const h of raw.results) hits.set(key(h), h);
            const capHit = raw.has_more || raw.total_hits > raw.results.length;
            return { term, role, total_hits: raw.total_hits, returned: raw.results.length, cap_hit: capHit, hits };
        }),
    );

    const allSubs = subs.filter((s) => s.role === "all_of");
    const anySubs = subs.filter((s) => s.role === "any_of");
    const noneSubs = subs.filter((s) => s.role === "none_of");

    // --- Set algebra over the windows -------------------------------------
    // 1) AND across all_of: intersection of each all_of term's hit set.
    let candidate: Map<string, RawHit> | null = null;
    for (const s of allSubs) {
        if (candidate === null) {
            candidate = new Map(s.hits);
        } else {
            const next = new Map<string, RawHit>();
            for (const [k, h] of candidate) if (s.hits.has(k)) next.set(k, h);
            candidate = next;
        }
    }

    // 2) OR across any_of: union of the any_of term hit sets, then intersect
    //    with the all_of candidate (if all_of was given).
    if (anySubs.length > 0) {
        const union = new Map<string, RawHit>();
        for (const s of anySubs) for (const [k, h] of s.hits) if (!union.has(k)) union.set(k, h);
        if (candidate === null) {
            candidate = union;
        } else {
            const next = new Map<string, RawHit>();
            for (const [k, h] of candidate) if (union.has(k)) next.set(k, h);
            candidate = next;
        }
    }
    if (candidate === null) candidate = new Map();

    // 3) NOT: drop any page in the union of none_of hit windows.
    const excluded = new Set<string>();
    for (const s of noneSubs) for (const k of s.hits.keys()) excluded.add(k);
    const survivors: RawHit[] = [];
    for (const [k, h] of candidate) if (!excluded.has(k)) survivors.push(h);

    // Stable order: book_id then page_id (deterministic pagination).
    survivors.sort((a, b) => (a.book_id - b.book_id) || (a.page_id - b.page_id));

    // Attach which all_of/any_of terms contributed each surviving page.
    const contributingSubs = [...allSubs, ...anySubs];
    const matchedTermsByKey = new Map<string, string[]>();
    for (const h of survivors) {
        const k = key(h);
        const terms: string[] = [];
        for (const s of contributingSubs) if (s.hits.has(k)) terms.push(s.term);
        matchedTermsByKey.set(k, terms);
    }

    const totalInWindow = survivors.length;

    // --- Paginate + enrich the page slice ---------------------------------
    const offset = args.offset;
    const pageSlice = survivors.slice(offset, offset + args.limit);
    const hasMore = offset + pageSlice.length < totalInWindow;
    const nextOffset = hasMore ? offset + pageSlice.length : undefined;

    // Batch printed-page lookups: one SQLite query per book (kills the N+1).
    const pageIdsByBook = new Map<number, number[]>();
    for (const h of pageSlice) {
        const list = pageIdsByBook.get(h.book_id) ?? [];
        list.push(h.page_id);
        pageIdsByBook.set(h.book_id, list);
    }
    const printedByBook = new Map<number, Map<number, string | null>>();
    await Promise.all(
        Array.from(pageIdsByBook.entries()).map(async ([bookId, pageIds]) => {
            printedByBook.set(bookId, await pages.printedPages(bookId, pageIds));
        }),
    );

    const results: BooleanHit[] = pageSlice.map((h) => {
        const rec = catalog.bookRecord(h.book_id);
        const k = key(h);
        return {
            book_id: h.book_id,
            book_name: rec?.book_name ?? `(unknown ${h.book_id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            category: rec ? catalog.categoryPath(rec.book_category)[0] ?? null : null,
            book_date: rec?.book_date ?? null,
            page_id: h.page_id,
            printed_page: printedByBook.get(h.book_id)?.get(h.page_id) ?? null,
            matched_in: h.matched_in,
            matched_terms: matchedTermsByKey.get(k) ?? [],
            snippet_body: h.snippet_body,
            snippet_foot: h.snippet_foot,
            ...(h.snippet_comment ? { snippet_comment: h.snippet_comment } : {}),
        };
    });

    // --- Honesty flags + notes --------------------------------------------
    const contributingCapHit = contributingSubs.some((s) => s.cap_hit);
    const noneOfCapHit = noneSubs.some((s) => s.cap_hit);
    const candidateCapHit = contributingCapHit || noneOfCapHit;

    const notes: string[] = [];
    if (candidateCapHit) {
        notes.push(
            "بعض المصطلحات تجاوزت سقف نافذة المرشَّحات؛ النتائج أفضل جهد ضمن نافذةٍ محدودة لا مسحٌ شامل. ضيِّق النطاق (scope) لتغطيةٍ أوثق.",
        );
    }
    if (noneSubs.length > 0 && noneOfCapHit) {
        notes.push(
            "الاستثناء (none_of) طُبِّق داخل النافذة فقط؛ قد تمر صفحةٌ تحوي مصطلحًا مستثنًى إن كان خارج نافذة ذلك المصطلح.",
        );
    }
    if (scopeCount < 0) {
        notes.push(
            "لم تُحدِّد نطاقًا (scope): البحث المنطقي بلا نطاقٍ على مكتبةٍ كبيرة غير موثوق. حدِّد كتبًا أو تصنيفًا أو مؤلِّفًا.",
        );
    }

    const subqueries: SubqueryReport[] = subs.map((s) => ({
        term: s.term,
        role: s.role,
        total_hits: s.total_hits,
        window_returned: s.returned,
        cap_hit: s.cap_hit,
    }));

    const out: SearchBooleanOutput = {
        all_of: allOf,
        any_of: anyOf,
        none_of: noneOf,
        scope_count: scopeCount,
        total_in_window: totalInWindow,
        returned: results.length,
        offset,
        has_more: hasMore,
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
        candidate_cap_hit: candidateCapHit,
        none_of_within_window: noneOfCapHit,
        subqueries,
        notes,
        results,
    };

    return renderResponse(out, args.response_format, (data) => {
        const parts: string[] = [];
        if (data.all_of.length) parts.push(`الكل: «${data.all_of.join("» و«")}»`);
        if (data.any_of.length) parts.push(`أيّ: «${data.any_of.join("» أو «")}»`);
        if (data.none_of.length) parts.push(`دون: «${data.none_of.join("» و«")}»`);
        const lines = [header(1, `بحث منطقي: ${parts.join(" — ")}`)];
        lines.push(
            `**${arabize(data.total_in_window)}** صفحة ضمن النافذة، عرض ${arabize(data.returned)} ابتداءً من ${arabize(data.offset)}.`,
        );
        if (data.scope_count >= 0) lines.push(`النطاق: ${arabize(data.scope_count)} كتاب.`);
        for (const n of data.notes) lines.push(`*ملاحظة: ${n}*`);
        lines.push("");
        for (const r of data.results) {
            lines.push(
                `## ${r.book_name}${r.printed_page ? ` (ص ${arabize(r.printed_page)})` : ""} — page_id=${r.page_id}`,
            );
            if (r.author_name) lines.push(`*${r.author_name}*${r.book_date ? ` — ${arabize(r.book_date)}هـ` : ""}`);
            if (r.matched_terms.length) lines.push(`_وافق_: ${r.matched_terms.join("، ")}`);
            if (r.snippet_body) lines.push("", `> ${r.snippet_body}`);
            if (r.snippet_foot) lines.push("", `> _حاشية_: ${r.snippet_foot}`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        return lines.join("\n");
    });
}

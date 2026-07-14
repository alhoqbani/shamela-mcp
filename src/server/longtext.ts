/**
 * Long-text handling helpers (#16, pattern ported from the
 * tafsir-mcp v2 pattern of `part`/`total_parts`/`has_more` + a `_display` hint).
 *
 * Two pure utilities:
 *   getChunk(text, partIndex, budget)      — split one long string into parts and
 *                                            return the requested 1-based part.
 *   trimPagesByBudget(pages, budget)       — keep a prefix of pages whose cumulative
 *                                            body+foot length fits a character budget
 *                                            (always keeps at least one page).
 *
 * Both are I/O-free so they live in tests/unit.
 */

export interface TextChunk {
    text: string;
    part: number;
    total_parts: number;
    has_more: boolean;
}

/** Split `text` into ~`budget`-sized parts on safe boundaries (paragraph → line → space). */
export function splitIntoParts(text: string, budget: number): string[] {
    if (budget <= 0 || text.length <= budget) return [text];
    const parts: string[] = [];
    let rest = text;
    const floor = Math.floor(budget * 0.5);
    while (rest.length > budget) {
        let cut = rest.lastIndexOf("\n\n", budget);
        if (cut < floor) cut = rest.lastIndexOf("\n", budget);
        if (cut < floor) cut = rest.lastIndexOf(" ", budget);
        if (cut < floor) cut = budget; // no good boundary — hard cut
        const head = rest.slice(0, cut).trim();
        if (head) parts.push(head);
        rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest.length) parts.push(rest);
    return parts.length ? parts : [text];
}

/** Return the requested 1-based part of `text`, split at `budget` characters. */
export function getChunk(text: string, partIndex: number, budget: number): TextChunk {
    const parts = splitIntoParts(text, budget);
    const total = parts.length;
    const idx = Math.min(Math.max(1, Math.floor(partIndex) || 1), total);
    return {
        text: parts[idx - 1] ?? "",
        part: idx,
        total_parts: total,
        has_more: idx < total,
    };
}

/**
 * Keep the longest prefix of `pages` whose cumulative (body + foot) character
 * count stays within `budget`. Always keeps at least the first page (so a single
 * huge page is still returned). Returns the kept prefix and whether a trim happened.
 */
export function trimPagesByBudget<T extends { body: string; foot: string }>(
    pages: T[],
    budget: number,
): { kept: T[]; trimmed: boolean } {
    if (pages.length <= 1 || budget <= 0) return { kept: pages, trimmed: false };
    const kept: T[] = [];
    let acc = 0;
    for (const p of pages) {
        const len = (p.body?.length ?? 0) + (p.foot?.length ?? 0);
        if (kept.length >= 1 && acc + len > budget) {
            return { kept, trimmed: true };
        }
        kept.push(p);
        acc += len;
    }
    return { kept, trimmed: false };
}

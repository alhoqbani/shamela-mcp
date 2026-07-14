/**
 * shamela_books_by_period — catalog-only temporal filter that keeps the two
 * temporal dimensions DISTINCT (#21):
 *
 *   - composed_from / composed_to  → book.book_date  (year the BOOK was composed)
 *   - died_from    / died_to       → author.death_year (year the MAIN AUTHOR died)
 *
 * The legacy `scope.period_from`/`period_to` (see CatalogScope.resolveBookIds)
 * CONFLATES these — it unions books whose composition year OR whose author's
 * death year falls in a single range. That is wrong for real research: a book
 * composed in 800h by an author who died in 850h answers a different question
 * than a book whose author died in 800h. This tool separates them: a book
 * matches only if it satisfies ALL provided constraints simultaneously
 * (composition-year AND death-year AND category AND downloaded), never a union.
 *
 * Pure Node / master.db logic — deterministic, read-only, no Java helper.
 * Returns matching book_ids the caller then passes as scope.book_ids to the
 * search tools.
 */

import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { badArg } from "../errors.js";
import { ResponseFormatInput, PaginationInput } from "../schemas.js";
import { renderResponse, type RenderedResponse, header, arabize } from "../format.js";

export const booksByPeriodInputShape = {
    composed_from: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
            "Hijri year, inclusive LOWER bound on the BOOK's composition year (book.book_date). Distinct from author death year — use died_from for that. Pair with composed_to.",
        ),
    composed_to: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
            "Hijri year, inclusive UPPER bound on the BOOK's composition year (book.book_date). Pair with composed_from.",
        ),
    died_from: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
            "Hijri year, inclusive LOWER bound on the MAIN AUTHOR's death year (author.death_year). Distinct from the book's composition year — use composed_from for that. Pair with died_to.",
        ),
    died_to: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
            "Hijri year, inclusive UPPER bound on the MAIN AUTHOR's death year (author.death_year). Pair with died_from.",
        ),
    category_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Optional: restrict to one category (use shamela_list_categories for IDs). Categories are flat in master.db.",
        ),
    downloaded_only: z
        .boolean()
        .default(false)
        .describe(
            "If true, restrict to books actually downloaded on this machine (master.db.book.major_ondisk > 0) — the only ones with searchable page content.",
        ),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const booksByPeriodInput = z.object(booksByPeriodInputShape).strict();

export interface BooksByPeriodRow {
    book_id: number;
    book_name: string;
    /** Main author's display name (join on book.main_author), null if none. */
    main_author_name: string | null;
    /** Main author's Hijri death year (null when unknown/modern → excluded when a died_* bound is set). */
    main_author_death_year: number | null;
    /** Book composition year (book.book_date, Hijri; null → excluded when a composed_* bound is set). */
    book_date: number | null;
    category_id: number | null;
    category: string | null;
    /** master.db.book.major_ondisk > 0 (flagged downloaded on this machine). */
    downloaded: boolean;
}

export interface BooksByPeriodOutput {
    total: number;
    returned: number;
    offset: number;
    has_more: boolean;
    next_offset?: number;
    /** Echo of the applied constraints so the caller can confirm the split was honored. */
    filter: {
        composed_from: number | null;
        composed_to: number | null;
        died_from: number | null;
        died_to: number | null;
        category_id: number | null;
        downloaded_only: boolean;
    };
    /** Convenience: the matching ids to feed straight into scope.book_ids of a search tool. */
    book_ids: number[];
    books: BooksByPeriodRow[];
}

/**
 * Filter the catalog by composition year and/or main-author death year, kept
 * as DISTINCT AND-combined constraints. Catalog-only and synchronous.
 * Throws BAD_ARG if none of the four temporal bounds is provided.
 */
export function runBooksByPeriod(
    catalog: Catalog,
    args: z.infer<typeof booksByPeriodInput>,
): RenderedResponse<BooksByPeriodOutput> {
    const hasComposed = args.composed_from !== undefined || args.composed_to !== undefined;
    const hasDied = args.died_from !== undefined || args.died_to !== undefined;
    if (!hasComposed && !hasDied) {
        throw badArg(
            "حدِّد نطاقًا زمنيًّا واحدًا على الأقل: composed_from/composed_to (سنة التأليف) أو died_from/died_to (سنة وفاة المؤلف). هذه الأداة تفصل سنة التأليف عن سنة الوفاة (المقترح ٩).",
        );
    }

    // Open-ended bounds: a missing side of a provided range is treated as the
    // widest possible year. When NEITHER side of a dimension is provided, that
    // dimension is not constrained at all (its rows aren't dropped for a null).
    const composedLo = hasComposed ? args.composed_from ?? 1 : null;
    const composedHi = hasComposed ? args.composed_to ?? 2000 : null;
    const diedLo = hasDied ? args.died_from ?? 1 : null;
    const diedHi = hasDied ? args.died_to ?? 2000 : null;

    const matched: BooksByPeriodRow[] = [];

    for (const b of catalog.allBooks()) {
        // Composition-year constraint (only when a composed_* bound was given).
        if (composedLo !== null) {
            if (b.book_date === null) continue; // no composition year → excluded under a composed_* bound
            if (b.book_date < composedLo || b.book_date > (composedHi as number)) continue;
        }

        // Main-author death-year constraint (only when a died_* bound was given).
        const author = b.main_author !== null ? catalog.authorRecord(b.main_author) : undefined;
        if (diedLo !== null) {
            const dy = author?.death_year ?? null;
            if (dy === null) continue; // unknown/modern death year → excluded under a died_* bound
            if (dy < diedLo || dy > (diedHi as number)) continue;
        }

        // Category constraint.
        if (args.category_id !== undefined && b.book_category !== args.category_id) continue;

        // Downloaded constraint.
        const downloaded = b.major_ondisk > 0;
        if (args.downloaded_only && !downloaded) continue;

        matched.push({
            book_id: b.book_id,
            book_name: b.book_name,
            main_author_name: catalog.mainAuthorName(b),
            main_author_death_year: author?.death_year ?? null,
            book_date: b.book_date,
            category_id: b.book_category,
            category: catalog.categoryPath(b.book_category)[0] ?? null,
            downloaded,
        });
    }

    matched.sort((x, y) => x.book_id - y.book_id);

    const slice = matched.slice(args.offset, args.offset + args.limit);
    const hasMore = args.offset + slice.length < matched.length;
    const out: BooksByPeriodOutput = {
        total: matched.length,
        returned: slice.length,
        offset: args.offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: args.offset + slice.length } : {}),
        filter: {
            composed_from: args.composed_from ?? null,
            composed_to: args.composed_to ?? null,
            died_from: args.died_from ?? null,
            died_to: args.died_to ?? null,
            category_id: args.category_id ?? null,
            downloaded_only: args.downloaded_only,
        },
        book_ids: slice.map((r) => r.book_id),
        books: slice,
    };

    return renderResponse(out, args.response_format, (data) => {
        const f = data.filter;
        const parts: string[] = [];
        if (f.composed_from !== null || f.composed_to !== null) {
            parts.push(
                `سنة التأليف ${arabize(f.composed_from ?? "…")}–${arabize(f.composed_to ?? "…")}هـ`,
            );
        }
        if (f.died_from !== null || f.died_to !== null) {
            parts.push(`سنة وفاة المؤلف ${arabize(f.died_from ?? "…")}–${arabize(f.died_to ?? "…")}هـ`);
        }
        if (f.category_id !== null) {
            parts.push(
                `التصنيف ${catalog.category(f.category_id)?.category_name ?? f.category_id}`,
            );
        }
        if (f.downloaded_only) parts.push("المنزَّلة فقط");
        const scope = parts.length ? ` (${parts.join("، ")})` : "";

        const lines = [
            header(1, `كتب حسب المدة${scope} — ${arabize(data.total)}`),
            `عرض ${arabize(data.returned)} من ${arabize(data.total)} ابتداءً من ${arabize(data.offset)}`,
            "",
        ];
        for (const b of data.books) {
            lines.push(`## ${b.book_name} (id=${b.book_id})${b.downloaded ? " — منزَّل" : ""}`);
            if (b.main_author_name) {
                const dy = b.main_author_death_year ? ` (ت ${arabize(b.main_author_death_year)}هـ)` : "";
                lines.push(`- المؤلف: ${b.main_author_name}${dy}`);
            }
            if (b.book_date) lines.push(`- سنة التأليف: ${arabize(b.book_date)}هـ`);
            if (b.category) lines.push(`- التصنيف: ${b.category} (id=${b.category_id})`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        lines.push(
            "",
            "*تنبيه: هذه الأداة تفصل سنة التأليف (book_date) عن سنة وفاة المؤلف الرئيس (death_year)، بخلاف scope.period القديم الذي يخلط بينهما. مرِّر `book_ids` الناتجة إلى scope.book_ids في أدوات البحث.*",
        );
        return lines.join("\n");
    });
}

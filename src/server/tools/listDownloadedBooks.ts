import { z } from "zod";

import type { Catalog } from "../catalog.js";
import type { PageStore } from "../pages.js";
import { ResponseFormatInput, PaginationInput } from "../schemas.js";
import { renderResponse, type RenderedResponse, header, arabize } from "../format.js";

export const listDownloadedBooksInputShape = {
    category_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Optional: restrict to one category (use shamela_list_categories for IDs). Shamela is a multi-category library — e.g. tafsir spans category 3 (التفسير), 4 (علوم القرآن وأصول التفسير), and 5 (التجويد والقراءات).",
        ),
    ...PaginationInput,
    ...ResponseFormatInput,
};
export const listDownloadedBooksInput = z.object(listDownloadedBooksInputShape).strict();

export type ContentStatus = "readable" | "downloaded_no_pages";

export interface DownloadedBookRow {
    book_id: number;
    book_name: string;
    author_name: string | null;
    category_id: number | null;
    category: string | null;
    book_date: number | null;
    /** "readable" = per-book DB has pages; "downloaded_no_pages" = flagged but text not openable. */
    content_status: ContentStatus;
}

export interface CategoryTally {
    category_id: number;
    category_name: string;
    count: number;
}

export interface ListDownloadedBooksOutput {
    total: number;
    returned: number;
    offset: number;
    has_more: boolean;
    next_offset?: number;
    filtered_category_id: number | null;
    /** Distribution of the WHOLE downloaded library across categories (registry view). */
    library_by_category: CategoryTally[];
    books: DownloadedBookRow[];
}

export async function runListDownloadedBooks(
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof listDownloadedBooksInput>,
): Promise<RenderedResponse<ListDownloadedBooksOutput>> {
    const allIds = Array.from(catalog.downloadedBookIds());

    // Whole-library distribution across categories (the "registry" overview),
    // computed before any category filter so the model always sees the landscape.
    const tally = new Map<number, number>();
    for (const id of allIds) {
        const rec = catalog.bookRecord(id);
        const cid = rec?.book_category ?? -1;
        tally.set(cid, (tally.get(cid) ?? 0) + 1);
    }
    const libraryByCategory: CategoryTally[] = Array.from(tally.entries())
        .map(([cid, count]) => ({
            category_id: cid,
            category_name: cid >= 0 ? catalog.category(cid)?.category_name ?? `(${cid})` : "(غير مصنَّف)",
            count,
        }))
        .sort((a, b) => b.count - a.count);

    let ids = allIds;
    if (args.category_id !== undefined) {
        ids = ids.filter((id) => catalog.bookRecord(id)?.book_category === args.category_id);
    }
    ids.sort((a, b) => a - b);

    const slice = ids.slice(args.offset, args.offset + args.limit);
    // Sequential on purpose: bookHasContent opens the per-book sql.js DB
    // (whole file in WASM memory). A concurrent Promise.all over a large
    // slice holds up to `limit` DBs in flight at once and can exhaust the
    // WASM heap ("INTERNAL: out of memory") on big libraries.
    const books: DownloadedBookRow[] = [];
    for (const id of slice) {
        const rec = catalog.bookRecord(id);
        const hasContent = await pages.bookHasContent(id);
        books.push({
            book_id: id,
            book_name: rec?.book_name ?? `(unknown ${id})`,
            author_name: rec ? catalog.mainAuthorName(rec) : null,
            category_id: rec?.book_category ?? null,
            category: rec ? catalog.categoryPath(rec.book_category)[0] ?? null : null,
            book_date: rec?.book_date ?? null,
            content_status: hasContent ? "readable" : "downloaded_no_pages",
        });
    }
    const hasMore = args.offset + slice.length < ids.length;
    const out: ListDownloadedBooksOutput = {
        total: ids.length,
        returned: books.length,
        offset: args.offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: args.offset + slice.length } : {}),
        filtered_category_id: args.category_id ?? null,
        library_by_category: libraryByCategory,
        books,
    };
    return renderResponse(out, args.response_format, (data) => {
        const scope = data.filtered_category_id !== null
            ? ` في تصنيف ${catalog.category(data.filtered_category_id)?.category_name ?? data.filtered_category_id}`
            : "";
        const lines = [
            header(1, `الكتب المنزَّلة محليًّا${scope} (${arabize(data.total)})`),
            `عرض ${arabize(data.returned)} من ${arabize(data.total)} ابتداءً من ${arabize(data.offset)}`,
            "",
        ];
        if (data.filtered_category_id === null && data.library_by_category.length) {
            lines.push(header(3, "توزيع المكتبة على التصنيفات"));
            for (const t of data.library_by_category.slice(0, 12)) {
                lines.push(`- ${t.category_name}: ${arabize(t.count)}`);
            }
            lines.push("");
        }
        for (const b of data.books) {
            const status = b.content_status === "readable" ? "" : "  ⚠️ منزَّل بلا صفحات مقروءة";
            lines.push(`## ${b.book_name} (id=${b.book_id})${status}`);
            if (b.author_name) lines.push(`- المؤلف: ${b.author_name}`);
            if (b.category) lines.push(`- التصنيف: ${b.category} (id=${b.category_id})`);
            if (b.book_date) lines.push(`- سنة التأليف: ${arabize(b.book_date)}هـ`);
            lines.push("");
        }
        if (data.has_more) lines.push(`*للمزيد، استخدم \`offset=${data.next_offset}\`.*`);
        return lines.join("\n");
    });
}

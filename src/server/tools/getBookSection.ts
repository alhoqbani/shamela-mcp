import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { MULTIPAGE_CHAR_BUDGET } from "../constants.js";
import { bookNotDownloaded, bookNotFound, titleNotFound } from "../errors.js";
import type { Helper } from "../helper.js";
import { trimPagesByBudget } from "../longtext.js";
import type { PageStore } from "../pages.js";
import { ResponseFormatInput } from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const getBookSectionInputShape = {
    book_id: z.number().int().positive().describe("The book id."),
    title_id: z.number().int().positive().describe("The title id of the chapter / section to fetch (use shamela_get_toc to find IDs)."),
    max_pages: z.number().int().min(1).max(100).default(30).describe("Cap on pages to read (1–100, default 30). Sections longer than this are truncated with a flag."),
    keep_html: z.boolean().default(false).describe("Preserve inline HTML markers."),
    ...ResponseFormatInput,
};
export const getBookSectionInput = z.object(getBookSectionInputShape).strict();

export interface SectionPage {
    page_id: number;
    printed_page: string | null;
    part: string | null;
    body: string;
    foot: string;
    comment: string;
}

export interface GetBookSectionOutput {
    book_id: number;
    book_name: string;
    author_name: string | null;
    title_id: number;
    title_text: string;
    start_page_id: number;
    end_page_id: number;
    total_pages_in_section: number;
    truncated: boolean;
    next_start_page_id: number | null;
    /** Display advice when the section was cut short (by max_pages or char budget). */
    _display: string | null;
    pages: SectionPage[];
}

const HTML_TAG_RE = /<[^>]+>/g;

export async function runGetBookSection(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof getBookSectionInput>,
): Promise<RenderedResponse<GetBookSectionOutput>> {
    const rec = catalog.bookRecord(args.book_id);
    if (!rec) throw bookNotFound(args.book_id);
    if (rec.major_ondisk === 0) throw bookNotDownloaded(args.book_id, rec.book_name);

    const section = await pages.getSection(args.book_id, args.title_id);
    if (!section) throw titleNotFound(args.book_id, args.title_id);

    const titleBatch = await helper.request<{
        results: Array<{ title_id: number; title_text: string }>;
    }>("get_titles_batch", { book_id: args.book_id, title_ids: [args.title_id] });
    const titleText = titleBatch.results[0]?.title_text ?? "";

    const max = Math.min(args.max_pages, section.total_pages);
    const rows = await pages.getPagesRange(args.book_id, section.start_page_id, max);
    const pageIds = rows.map((r) => r.page_id);
    const batch = pageIds.length
        ? await helper.request<{
              results: Array<{ page_id: number; body: string; foot: string; comment: string }>;
          }>("get_pages_batch", { book_id: args.book_id, page_ids: pageIds })
        : { results: [] };
    const contentMap = new Map(batch.results.map((r) => [r.page_id, r]));

    const stripIfHtml = (s: string) => (args.keep_html ? s : s.replace(HTML_TAG_RE, "").replace(/\r/g, "\n"));

    const allPages: SectionPage[] = await Promise.all(
        rows.map(async (r) => {
            const c = contentMap.get(r.page_id) ?? { body: "", foot: "", comment: "" };
            const printed = await pages.printedPage(args.book_id, r.page_id);
            return {
                page_id: r.page_id,
                printed_page: printed,
                part: r.part,
                body: stripIfHtml(c.body),
                foot: stripIfHtml(c.foot),
                comment: stripIfHtml(c.comment),
            };
        }),
    );

    // #16 — stop early when bodies are large, even within max_pages, so a
    // long chapter doesn't dump in one response.
    const { kept: pagesOut, trimmed: budgetTrimmed } = trimPagesByBudget(allPages, MULTIPAGE_CHAR_BUDGET);
    const lastId = pagesOut.length ? pagesOut[pagesOut.length - 1]!.page_id : section.start_page_id - 1;
    const truncated = pagesOut.length < section.total_pages;
    const moreInSection = lastId < section.end_page_id;
    const display = truncated
        ? (budgetTrimmed
              ? `القسم طويل، فعُرِض ${arabize(pagesOut.length)} من ${arabize(section.total_pages)} صفحة لضبط الحجم. أكمِل بـ shamela_get_pages_range(start_page_id=${lastId + 1}) أو ارفع max_pages.`
              : `القسم مقطوع عند حدّ max_pages — عُرِض ${arabize(pagesOut.length)} من ${arabize(section.total_pages)}. أكمِل بـ start_page_id=${lastId + 1} أو ارفع max_pages.`)
        : null;

    const out: GetBookSectionOutput = {
        book_id: args.book_id,
        book_name: rec.book_name,
        author_name: catalog.mainAuthorName(rec),
        title_id: args.title_id,
        title_text: titleText,
        start_page_id: section.start_page_id,
        end_page_id: section.end_page_id,
        total_pages_in_section: section.total_pages,
        truncated,
        next_start_page_id: moreInSection ? lastId + 1 : null,
        _display: display,
        pages: pagesOut,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [
            header(1, `${data.book_name} — ${data.title_text || "(بدون عنوان)"}`),
            data.author_name ? `*${data.author_name}*` : "",
            `صفحات ${arabize(data.start_page_id)}–${arabize(data.end_page_id)} (إجمالي ${arabize(data.total_pages_in_section)})`,
        ].filter(Boolean);
        for (const p of data.pages) {
            lines.push("", header(3, `صفحة ${arabize(p.printed_page ?? p.page_id)}`));
            if (p.body) lines.push(p.body);
            if (p.foot) lines.push("", `_${p.foot}_`);
        }
        if (data._display) lines.push("", `> *${data._display}*`);
        return lines.join("\n");
    });
}

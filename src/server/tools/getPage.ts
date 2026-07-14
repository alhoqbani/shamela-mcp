import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { PAGE_BODY_BUDGET } from "../constants.js";
import { bookNotDownloaded, bookNotFound, pageNotFound } from "../errors.js";
import type { Helper } from "../helper.js";
import { getChunk } from "../longtext.js";
import type { PageStore, TocEntry } from "../pages.js";
import { ResponseFormatInput } from "../schemas.js";
import { arabize, header, renderResponse, type RenderedResponse } from "../format.js";

export const getPageInputShape = {
    book_id: z.number().int().positive().describe("The book id."),
    page_id: z.number().int().positive().describe("The page id (Lucene/SQLite internal id, not the printed page number)."),
    keep_html: z.boolean().default(false).describe("If true, preserve inline HTML markers (e.g. <span data-type='title'>). Default false strips them for plain Arabic display."),
    body_part: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe(
            `For long pages: when the body exceeds ~${PAGE_BODY_BUDGET} characters it is split into parts. Pass the 1-based part to read (default 1). The response reports body_part/body_total_parts/body_has_more; request the next part by incrementing. The footnote/comment are returned with part 1.`,
        ),
    ...ResponseFormatInput,
};
export const getPageInput = z.object(getPageInputShape).strict();

export interface ContainingTitle {
    title_id: number;
    title_text: string;
    page_id: number;
}

export interface GetPageOutput {
    book_id: number;
    book_name: string;
    author_name: string | null;
    page_id: number;
    printed_page: string | null;
    part: string | null;
    body: string;
    foot: string;
    comment: string;
    /** 1-based index of the body part returned (1 when the page is short). */
    body_part: number;
    /** Total number of parts the body was split into (1 when short). */
    body_total_parts: number;
    /** True when further body parts remain (fetch with body_part+1). */
    body_has_more: boolean;
    /** Display advice when the body is long enough to be split; null otherwise. */
    _display: string | null;
    prev_page_id: number | null;
    next_page_id: number | null;
    containing_titles: ContainingTitle[];
    category_path: string[];
}

const HTML_TAG_RE = /<[^>]+>/g;

export async function runGetPage(
    helper: Helper,
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof getPageInput>,
): Promise<RenderedResponse<GetPageOutput>> {
    const rec = catalog.bookRecord(args.book_id);
    if (!rec) throw bookNotFound(args.book_id);
    if (rec.major_ondisk === 0) throw bookNotDownloaded(args.book_id, rec.book_name);

    const row = await pages.getPageRow(args.book_id, args.page_id);
    if (!row) throw pageNotFound(args.book_id, args.page_id);

    const batch = await helper.request<{
        book_id: number;
        results: Array<{ page_id: number; found: boolean; body: string; foot: string; comment: string }>;
    }>("get_pages_batch", { book_id: args.book_id, page_ids: [args.page_id] });
    const content = batch.results[0];

    const totalPages = await pages.pageCount(args.book_id);
    const ancestor = await pages.getAncestorChain(args.book_id, args.page_id);

    // Get title_text for each ancestor.
    const titleIds = ancestor.map((a) => a.title_id);
    let titleMap: Map<number, string> = new Map();
    if (titleIds.length > 0) {
        const titles = await helper.request<{
            results: Array<{ title_id: number; title_text: string }>;
        }>("get_titles_batch", { book_id: args.book_id, title_ids: titleIds });
        titleMap = new Map(titles.results.map((t) => [t.title_id, t.title_text]));
    }

    const stripIfHtml = (s: string) => (args.keep_html ? s : s.replace(HTML_TAG_RE, "").replace(/\r/g, "\n"));

    const fullBody = stripIfHtml(content?.body ?? "");
    const fullFoot = stripIfHtml(content?.foot ?? "");
    const fullComment = stripIfHtml(content?.comment ?? "");

    // #16 — paginate a long page body so the model never dumps a huge
    // page in one shot. Short pages stay a single part (no _display advice).
    const chunk = getChunk(fullBody, args.body_part, PAGE_BODY_BUDGET);
    const onFirst = chunk.part === 1;
    const display =
        chunk.total_parts > 1
            ? `النص طويل، قُسِّم إلى ${arabize(chunk.total_parts)} أجزاء (هذا الجزء ${arabize(chunk.part)}). اعرض المعروض كاملًا حرفيًّا أو اسأل المستخدم عن طريقة العرض؛ ولجلب التالي استخدم body_part=${chunk.part < chunk.total_parts ? chunk.part + 1 : chunk.total_parts}. (الحاشية والتعليق يظهران مع الجزء الأول.)`
            : null;

    const printed = await pages.printedPage(args.book_id, args.page_id);
    const out: GetPageOutput = {
        book_id: args.book_id,
        book_name: rec.book_name,
        author_name: catalog.mainAuthorName(rec),
        page_id: args.page_id,
        printed_page: printed,
        part: row.part,
        body: chunk.text,
        foot: onFirst ? fullFoot : "",
        comment: onFirst ? fullComment : "",
        body_part: chunk.part,
        body_total_parts: chunk.total_parts,
        body_has_more: chunk.has_more,
        _display: display,
        prev_page_id: args.page_id > 1 ? args.page_id - 1 : null,
        next_page_id: args.page_id < totalPages ? args.page_id + 1 : null,
        containing_titles: ancestor.map((a: TocEntry) => ({
            title_id: a.title_id,
            title_text: titleMap.get(a.title_id) ?? "",
            page_id: a.page_id,
        })),
        category_path: catalog.categoryPath(rec.book_category),
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines: string[] = [];
        lines.push(header(1, `${data.book_name}${data.printed_page ? ` (ص ${arabize(data.printed_page)})` : ""}`));
        if (data.author_name) lines.push(`*${data.author_name}*`);
        if (data.containing_titles.length) {
            lines.push("", header(3, "المسار"));
            lines.push(data.containing_titles.map((t) => t.title_text).filter(Boolean).join(" › "));
        }
        if (data.body) {
            lines.push("", header(3, data.body_total_parts > 1 ? `المتن (جزء ${arabize(data.body_part)}/${arabize(data.body_total_parts)})` : "المتن"));
            lines.push(data.body);
        }
        if (data._display) lines.push("", `> *${data._display}*`);
        if (data.foot) {
            lines.push("", header(3, "الحاشية"));
            lines.push(data.foot);
        }
        if (data.comment) {
            lines.push("", header(3, "التعليق"));
            lines.push(data.comment);
        }
        return lines.join("\n");
    });
}

import { z } from "zod";

import type { Catalog } from "../catalog.js";
import { bookNotFound } from "../errors.js";
import type { Helper } from "../helper.js";
import type { PageStore } from "../pages.js";
import { ResponseFormatInput } from "../schemas.js";
import { renderResponse, type RenderedResponse, header, meta, arabize } from "../format.js";

export const getBookInputShape = {
    book_id: z.number().int().positive().describe("The book id (e.g. 9942)."),
    ...ResponseFormatInput,
};
export const getBookInput = z.object(getBookInputShape).strict();

export interface AuthorEntry {
    author_id: number;
    author_name: string;
    death_year: number | null;
    role: "main" | "co";
}

/** Distinguishes the catalog flag from real readable content (#12). */
export type ContentStatus = "readable" | "downloaded_no_pages" | "not_downloaded";

export interface GetBookOutput {
    book_id: number;
    book_name: string;
    category_id: number | null;
    category: string | null;
    book_type: number;
    book_type_label: string;
    book_date: number | null;
    printed: number;
    available: boolean;
    downloaded: boolean;
    /** (#12): tri-state content availability, distinct from the catalog `downloaded` flag. */
    content_status: ContentStatus;
    authors: AuthorEntry[];
    pdf_links: string | null;
    publication_date: string | null;
    /** (#25): edition/publisher hint from Shamela's name suffix (e.g. «ت التركي»). */
    edition: string | null;
    /** (#25): muḥaqqiq, conservatively extracted from the book's front-matter (null if not clearly found). */
    editor: string | null;
    /** (#25): publisher, conservatively extracted from the book's front-matter (null if not clearly found). */
    publisher: string | null;
    sub_books: number[];
    notes: string[];
}

/**
 * Conservatively extract muḥaqqiq / publisher from a book's front-matter card.
 * Only reports a value when a clear «تحقيق: …» / «الناشر: …» pattern matches —
 * never guesses (quality over breadth). Returns nulls otherwise.
 */
function extractPubInfo(text: string): { editor: string | null; publisher: string | null } {
    const t = text.replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ");
    const grab = (re: RegExp): string | null => {
        const m = t.match(re);
        if (!m || !m[1]) return null;
        const v = m[1].split(/[،,\n.()[\]:|]/)[0]!.trim();
        return v.length >= 2 && v.length <= 70 ? v : null;
    };
    const editor =
        grab(/(?:المحقّ?ق|تحقيق|بتحقيق|دراسة وتحقيق)\s*[:：]\s*([^\n]{2,70})/) ??
        grab(/حقّ?قه\s+(?:وعلّق عليه\s+)?([^\n،.]{3,50})/);
    const publisher = grab(/(?:الناشر|دار النشر)\s*[:：]\s*([^\n]{2,70})/);
    return { editor, publisher };
}

const TYPE_LABELS: Record<number, string> = {
    1: "كتاب",
    2: "مجلة",
    3: "مخطوط",
    4: "رسالة جامعية",
    5: "إلكتروني",
    6: "صوتي",
};

export async function runGetBook(
    catalog: Catalog,
    pages: PageStore,
    helper: Helper,
    args: z.infer<typeof getBookInput>,
): Promise<RenderedResponse<GetBookOutput>> {
    const rec = catalog.bookRecord(args.book_id);
    if (!rec) throw bookNotFound(args.book_id);
    const authors = catalog.bookAuthors(rec).map((a, idx) => ({
        author_id: a.author_id,
        author_name: a.author_name,
        death_year: a.death_year,
        role: idx === 0 ? ("main" as const) : ("co" as const),
    }));
    // #12: master.db.book.major_ondisk can flip true while the per-book SQLite
    // is empty (electronic/image books, or a mid/interrupted download). Tri-state.
    const hasContent = rec.major_ondisk > 0 && (await pages.bookHasContent(rec.book_id));
    const content_status: ContentStatus =
        rec.major_ondisk <= 0 ? "not_downloaded" : hasContent ? "readable" : "downloaded_no_pages";

    // #25: edition / muḥaqqiq / publisher. Shamela encodes these in the
    // name suffix after « - » by a fixed convention: «ت <editor>» = taḥqīq
    // (muḥaqqiq), «ط <publisher>» = print/edition. Fall back to meta_data.suffix.
    const nameParts = rec.book_name.split(/\s+-\s+/);
    const suffix = (rec.meta_data?.suffix?.trim() || (nameParts.length > 1 ? nameParts[nameParts.length - 1]!.trim() : "")) || "";
    const edition = suffix || null;
    let editor: string | null = /^ت\s/.test(suffix) ? suffix.replace(/^ت\s+/, "").trim() : null;
    let publisher: string | null = /^ط\s/.test(suffix) ? suffix.replace(/^ط\s+/, "").trim() : null;

    // Fallback: conservatively mine the front-matter card when the name gave
    // neither — readable books only, never fabricate.
    if (content_status === "readable" && !editor && !publisher) {
        try {
            const rows = await pages.getPagesRange(rec.book_id, 1, 6);
            const ids = rows.map((r) => r.page_id);
            if (ids.length) {
                const batch = await helper.request<{ results: Array<{ body: string }> }>("get_pages_batch", {
                    book_id: rec.book_id,
                    page_ids: ids,
                });
                const front = batch.results.map((r) => r.body ?? "").join("\n");
                const info = extractPubInfo(front);
                editor = info.editor;
                publisher = info.publisher;
            }
        } catch {
            /* best-effort enrichment */
        }
    }

    const notes: string[] = [];
    if (content_status === "downloaded_no_pages")
        notes.push("flagged downloaded but has NO readable pages (electronic/image book, or an interrupted download) — do not quote from it");
    if (!editor) notes.push("muḥaqqiq (editor) not found in the front-matter; may need the printed source");
    if (!publisher) notes.push("publisher not found in the front-matter / not in master.db");
    if (!edition) notes.push("edition descriptor not present in the Shamela name suffix");
    notes.push("city of publication and edition number are not stored in master.db");

    const out: GetBookOutput = {
        book_id: rec.book_id,
        book_name: rec.book_name,
        category_id: rec.book_category,
        category: catalog.categoryPath(rec.book_category)[0] ?? null,
        book_type: rec.book_type,
        book_type_label: TYPE_LABELS[rec.book_type] ?? "غير معروف",
        book_date: rec.book_date,
        printed: rec.printed,
        available: rec.major_online > 0,
        downloaded: content_status === "readable",
        content_status,
        authors,
        pdf_links: rec.pdf_links,
        publication_date: rec.meta_data?.date ?? null,
        edition,
        editor,
        publisher,
        sub_books: rec.meta_data?.sub_books ?? [],
        notes,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [header(1, data.book_name)];
        lines.push(`- **المعرِّف**: ${data.book_id}`);
        if (data.authors.length) {
            const main = data.authors.find((a) => a.role === "main") ?? data.authors[0]!;
            lines.push(
                `- **المؤلف**: ${main.author_name}` +
                    (main.death_year ? ` (ت ${arabize(main.death_year)}هـ)` : ""),
            );
            const cos = data.authors.filter((a) => a.role === "co");
            if (cos.length) {
                lines.push(`- **مشاركون**: ${cos.map((a) => a.author_name).join("، ")}`);
            }
        }
        if (data.category) lines.push(`- **التصنيف**: ${data.category}`);
        lines.push(`- **النوع**: ${data.book_type_label}`);
        if (data.book_date) lines.push(`- **سنة التأليف**: ${arabize(data.book_date)}هـ`);
        const csLabel =
            data.content_status === "readable"
                ? "نعم (نصّه مقروء)"
                : data.content_status === "downloaded_no_pages"
                  ? "مفهرس كمنزَّل لكن **بلا صفحات مقروءة** (لا يُنقَل عنه)"
                  : "لا";
        lines.push(`- **منزَّل محليًّا**: ${csLabel}`);
        if (data.edition) lines.push(`- **الطبعة/الناشر (من اسم الشاملة)**: ${data.edition}`);
        if (data.editor) lines.push(`- **المحقق**: ${data.editor}`);
        if (data.publisher) lines.push(`- **الناشر**: ${data.publisher}`);
        if (data.publication_date) lines.push(`- **تاريخ النشر بالشاملة**: ${data.publication_date}`);
        if (data.notes.length) {
            lines.push("", "**ملاحظات على البيانات المتاحة**:");
            for (const n of data.notes) lines.push(`- ${n}`);
        }
        return lines.join("\n");
    });
}

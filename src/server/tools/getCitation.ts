import { z } from "zod";

import type { Catalog } from "../catalog.js";
import {
    type CitationComponents,
    formatFullCitation,
    formatShamelaCitation,
    formatShortCitation,
} from "../citation.js";
import { bookNotFound } from "../errors.js";
import type { PageStore } from "../pages.js";
import { ResponseFormatInput } from "../schemas.js";
import { renderResponse, type RenderedResponse, header } from "../format.js";

export const getCitationInputShape = {
    book_id: z.number().int().positive().describe("The book id."),
    page_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Optional page_id. When omitted, the citation references the book without a specific page (e.g. for a book-level citation).",
        ),
    text: z
        .string()
        .optional()
        .describe(
            "Optional quoted text. When provided in 'shamela' style, the output includes a two-line block: «<book>» (<part>/ <page>):\n«<text>».",
        ),
    style: z
        .enum(["shamela", "short", "full"])
        .default("shamela")
        .describe(
            "Citation style. 'shamela' replicates Shamela's UI copy-with-citation format (default). 'short' is a one-line inline reference. 'full' is the long form including author death year and book year, with notes listing missing fields (publisher/edition/etc are not in master.db).",
        ),
    ...ResponseFormatInput,
};
export const getCitationInput = z.object(getCitationInputShape).strict();

export interface GetCitationOutput {
    formatted: string;
    style: "shamela" | "short" | "full";
    components: CitationComponents;
    notes: string[];
}

export async function runGetCitation(
    catalog: Catalog,
    pages: PageStore,
    args: z.infer<typeof getCitationInput>,
): Promise<RenderedResponse<GetCitationOutput>> {
    const book = catalog.bookRecord(args.book_id);
    if (!book) throw bookNotFound(args.book_id);
    const author = book.main_author !== null ? catalog.authorRecord(book.main_author) ?? null : null;
    const pageRow = args.page_id !== undefined
        ? await pages.getPageRow(book.book_id, args.page_id)
        : null;
    const pageRef = pageRow
        ? { page_id: pageRow.page_id, part: pageRow.part, page: pageRow.page }
        : args.page_id !== undefined
            ? { page_id: args.page_id, part: null, page: null }
            : undefined;

    let formatted: string;
    let notes: string[] = [];
    let components: CitationComponents;
    if (args.style === "shamela") {
        formatted = formatShamelaCitation(book, author, pageRef, args.text);
        // Reuse buildComponents via formatFullCitation shape for components.
        const full = formatFullCitation(book, author, pageRef);
        components = full.components;
    } else if (args.style === "short") {
        formatted = formatShortCitation(book, author, pageRef);
        const full = formatFullCitation(book, author, pageRef);
        components = full.components;
    } else {
        const full = formatFullCitation(book, author, pageRef);
        formatted = full.formatted;
        components = full.components;
        notes = full.notes;
    }

    // (#25): surface muḥaqqiq/edition from the Shamela name
    // suffix («ت <editor>» / «ط <publisher>»), which master.db columns lack.
    const parts = book.book_name.split(/\s+-\s+/);
    const suffix = (book.meta_data?.suffix?.trim() || (parts.length > 1 ? parts[parts.length - 1]!.trim() : "")) || "";
    const editorFromName = /^ت\s/.test(suffix) ? suffix.replace(/^ت\s+/, "").trim() : null;
    const publisherFromName = /^ط\s/.test(suffix) ? suffix.replace(/^ط\s+/, "").trim() : null;
    if (editorFromName || publisherFromName) {
        const found: string[] = [];
        if (editorFromName) found.push(`المحقق (من اسم الشاملة): ${editorFromName}`);
        if (publisherFromName) found.push(`الناشر/الطبعة (من اسم الشاملة): ${publisherFromName}`);
        notes = found.concat(
            notes.filter(
                (n) => !(editorFromName && /editor|muḥaqqiq/i.test(n)) && !(publisherFromName && /publisher/i.test(n)),
            ),
        );
    }

    const out: GetCitationOutput = {
        formatted,
        style: args.style,
        components,
        notes,
    };
    return renderResponse(out, args.response_format, (data) => {
        const lines = [header(1, "الإحالة")];
        lines.push("```");
        lines.push(data.formatted);
        lines.push("```");
        if (data.notes.length) {
            lines.push("", header(2, "ملاحظات"));
            for (const n of data.notes) lines.push(`- ${n}`);
        }
        return lines.join("\n");
    });
}

/**
 * Error taxonomy per `docs/architecture.md`. User-visible parts are Arabic;
 * diagnostic parts (paths, stack contexts) stay English.
 */

import { ShamelaNotFoundError } from "./paths.js";
import { HelperError } from "./helper.js";

export type ErrorCode =
    | "SHAMELA_NOT_INSTALLED"
    | "SHAMELA_NOT_FOUND"
    | "BOOK_NOT_FOUND"
    | "BOOK_NOT_DOWNLOADED"
    | "BOOK_NOT_AVAILABLE"
    | "AUTHOR_NOT_FOUND"
    | "CATEGORY_NOT_FOUND"
    | "PAGE_NOT_FOUND"
    | "TITLE_NOT_FOUND"
    | "AYA_NOT_FOUND"
    | "SERVICE_KEY_NOT_FOUND"
    | "EMPTY_SCOPE"
    | "OPTION_NOT_SUPPORTED"
    | "OPTION_CONFLICT"
    | "BAD_ARG"
    | "HELPER_DIED"
    | "HELPER_TIMEOUT"
    | "INTERNAL";

export class ShamelaError extends Error {
    code: ErrorCode;
    data?: unknown;

    constructor(code: ErrorCode, message: string, data?: unknown) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "ShamelaError";
    }
}

export function bookNotFound(bookId: number): ShamelaError {
    return new ShamelaError("BOOK_NOT_FOUND", `الكتاب رقم ${bookId} غير موجود في الفهرس.`);
}

export function bookNotDownloaded(bookId: number, bookName?: string): ShamelaError {
    const name = bookName ? `«${bookName}» (${bookId})` : `رقم ${bookId}`;
    return new ShamelaError(
        "BOOK_NOT_DOWNLOADED",
        `الكتاب ${name} غير منزَّل محليًّا. نزِّله من تطبيق المكتبة الشاملة أولًا، ثم أعد تشغيل Claude Desktop.`,
    );
}

export function authorNotFound(authorId: number): ShamelaError {
    return new ShamelaError("AUTHOR_NOT_FOUND", `المؤلف رقم ${authorId} غير موجود في الفهرس.`);
}

export function categoryNotFound(categoryId: number): ShamelaError {
    return new ShamelaError("CATEGORY_NOT_FOUND", `التصنيف رقم ${categoryId} غير موجود.`);
}

export function pageNotFound(bookId: number, pageId: number): ShamelaError {
    return new ShamelaError(
        "PAGE_NOT_FOUND",
        `الصفحة رقم ${pageId} غير موجودة في الكتاب ${bookId}.`,
    );
}

export function titleNotFound(bookId: number, titleId: number): ShamelaError {
    return new ShamelaError(
        "TITLE_NOT_FOUND",
        `العنوان رقم ${titleId} غير موجود في الكتاب ${bookId}.`,
    );
}

export function ayaNotFound(detail: string): ShamelaError {
    return new ShamelaError("AYA_NOT_FOUND", `Aya ${detail} does not exist (range is 1..6236).`);
}

export function emptyScope(diagnostics: Array<{ source: string; contributed: number }>): ShamelaError {
    const lines = diagnostics.map((d) => `  ${d.source}: ${d.contributed}`).join("\n");
    return new ShamelaError(
        "EMPTY_SCOPE",
        `النطاق المحدَّد لا يشمل أي كتاب. تشخيص:\n${lines}`,
        { diagnostics },
    );
}

export function optionNotSupported(name: string): ShamelaError {
    return new ShamelaError(
        "OPTION_NOT_SUPPORTED",
        `Option '${name}' is not currently supported. The default analyzer already strips diacritics and folds alef/ya/waw/ta-marbuta. See docs/roadmap.md for the planned two-pass verification path.`,
    );
}

export function optionConflict(message: string): ShamelaError {
    return new ShamelaError("OPTION_CONFLICT", message);
}

export function badArg(message: string): ShamelaError {
    return new ShamelaError("BAD_ARG", message);
}

export function serviceKeyNotFound(service: string, key: number): ShamelaError {
    return new ShamelaError(
        "SERVICE_KEY_NOT_FOUND",
        `لا توجد كتب مفهرسة للمفتاح ${key} في خدمة ${service}.`,
    );
}

/** Format any error for an MCP tool error response. */
export function formatErrorMessage(err: unknown): string {
    if (err instanceof ShamelaError) return err.message;
    if (err instanceof ShamelaNotFoundError) return err.message;
    if (err instanceof HelperError) return `${err.code}: ${err.message}`;
    if (err instanceof Error) return err.message;
    return String(err);
}

/** Get the error code for any error (used by tool result envelopes). */
export function errorCode(err: unknown): ErrorCode {
    if (err instanceof ShamelaError) return err.code;
    if (err instanceof ShamelaNotFoundError) return "SHAMELA_NOT_FOUND";
    if (err instanceof HelperError) {
        const map: Record<string, ErrorCode> = {
            HELPER_DEAD: "HELPER_DIED",
            HELPER_DIED: "HELPER_DIED",
            HELPER_TIMEOUT: "HELPER_TIMEOUT",
            HELPER_ERROR: "INTERNAL",
            HELPER_WRITE_ERROR: "INTERNAL",
        };
        return map[err.code] ?? "INTERNAL";
    }
    return "INTERNAL";
}

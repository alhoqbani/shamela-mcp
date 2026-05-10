/**
 * Markdown/JSON renderers for tool responses + CHARACTER_LIMIT truncation.
 * Per `docs/architecture.md` §"Search result envelope" and mcp-builder
 * Node guide §"Character Limits and Truncation".
 *
 * Every tool returns dual content:
 *   content[0].text     — formatted per response_format (markdown or JSON)
 *   structuredContent   — typed JSON, always present
 *
 * Tool handlers should:
 *   1. Build the structured payload (typed object).
 *   2. Call `renderResponse(payload, response_format, renderMarkdown)` to get
 *      the text envelope. The renderer handles truncation transparently.
 *   3. Return `{ content, structuredContent: truncatedPayload }`.
 */

import { CHARACTER_LIMIT } from "./constants.js";

export interface RenderedResponse<T> {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: T;
}

/**
 * Format a structured payload for the text channel.
 * @param payload  Structured content (will also become structuredContent).
 * @param format   "markdown" or "json".
 * @param renderMarkdown  Function that formats the payload as markdown.
 *                        Called only when format === "markdown".
 */
export function renderResponse<T extends object>(
    payload: T,
    format: "markdown" | "json",
    renderMarkdown: (data: T) => string,
): RenderedResponse<T> {
    const text = format === "json" ? JSON.stringify(payload, null, 2) : renderMarkdown(payload);
    const truncated = enforceCharLimit(text);
    if (truncated.text === text) {
        return {
            content: [{ type: "text", text }],
            structuredContent: payload,
        };
    }
    // Add truncation flags onto the structured content too so callers can detect.
    const stamped = {
        ...payload,
        truncated: true,
        truncation_message: truncated.message,
    };
    return {
        content: [{ type: "text", text: truncated.text }],
        structuredContent: stamped as T,
    };
}

function enforceCharLimit(text: string): { text: string; message?: string } {
    if (text.length <= CHARACTER_LIMIT) return { text };
    const head = text.slice(0, CHARACTER_LIMIT - 200);
    const message = `\n\n[Response truncated from ${text.length} to ${head.length} characters. Use 'limit' or 'offset' parameters to page through more results, or add a tighter scope to narrow the result set.]`;
    return { text: head + message, message };
}

// --- Markdown helpers -------------------------------------------------------

/** Strip <mark>...</mark> tags from a snippet for plain-text display. */
export function stripMarkTags(s: string): string {
    return s.replace(/<\/?mark>/g, "**"); // Convert to bold for markdown.
}

/** Render an Arabic-Indic digit string from a number or numeric string. */
export function arabize(n: number | string | null | undefined): string {
    if (n === null || n === undefined || n === "") return "";
    const map: Record<string, string> = {
        "0": "٠", "1": "١", "2": "٢", "3": "٣", "4": "٤",
        "5": "٥", "6": "٦", "7": "٧", "8": "٨", "9": "٩",
    };
    return String(n).replace(/[0-9]/g, (d) => map[d] ?? d);
}

/** Render a section header (markdown). */
export function header(level: 1 | 2 | 3, text: string): string {
    return "#".repeat(level) + " " + text;
}

/** Render a labeled metadata line. */
export function meta(label: string, value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === "") return "";
    return `- **${label}**: ${value}`;
}

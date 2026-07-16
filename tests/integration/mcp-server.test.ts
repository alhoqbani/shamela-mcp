import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type Backend } from "../../src/server/index.js";
import { FIXTURE_BOOK_ID, getBackend, getCatalog } from "../fixtures/shared.js";

interface ToolText {
    type: "text";
    text: string;
}
interface CallResult {
    isError?: boolean;
    structuredContent?: unknown;
    content: ToolText[];
}

function errText(r: CallResult): string {
    return r.content[0]?.text ?? "";
}

const EXPECTED_TOOL_NAMES = [
    "shamela_search_pages",
    "shamela_search_titles",
    "shamela_search_books",
    "shamela_search_authors",
    "shamela_get_page",
    "shamela_get_toc",
    "shamela_get_book",
    "shamela_get_author",
    "shamela_list_categories",
    "shamela_resolve",
    "shamela_get_pages_range",
    "shamela_get_book_section",
    "shamela_get_citation",
    "shamela_search_quran",
    "shamela_get_aya",
    "shamela_get_tafseer_of_aya",
    "shamela_get_books_for_hadith",
    "shamela_list_downloaded_books",
    "shamela_get_book_parts",
    "shamela_get_page_services",
    "shamela_search_phrase",
    "shamela_search_hadith",
    "shamela_health",
    "shamela_search_exact",
    "shamela_search_boolean",
    "shamela_root_stats",
    "shamela_books_by_period",
    "shamela_list_tafsirs_for_aya",
    "shamela_get_tafseer_texts",
] as const;

const EXPECTED_PROMPT_NAMES = [
    "study_masala",
    "compare_madhahib",
    "trace_hadith",
    "tafsir_aya_muqaran",
    "tawthiq_nisba",
    "tatabbu_mustalah",
    "tarjamat_alim",
] as const;

describe("MCP server end-to-end (InMemoryTransport)", () => {
    let client: Client;
    let backend: Backend;

    beforeAll(async () => {
        backend = await getBackend();
        const server = createServer(async () => backend);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client(
            { name: "shamela-mcpb-test-client", version: "1.0.0" },
            { capabilities: {} },
        );
        await client.connect(clientTransport);
    });

    afterAll(async () => {
        await client.close();
    });

    it("lists all 29 expected tools", async () => {
        const result = await client.listTools();
        const names = new Set(result.tools.map((t) => t.name));
        for (const expected of EXPECTED_TOOL_NAMES) {
            expect(names.has(expected), `expected tool ${expected}`).toBe(true);
        }
        expect(result.tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
    });

    it("each tool exposes a non-empty title and description", async () => {
        const result = await client.listTools();
        for (const t of result.tools) {
            expect(t.title?.length ?? 0).toBeGreaterThan(0);
            expect(t.description?.length ?? 0).toBeGreaterThan(0);
        }
    });

    it("lists all 7 expected prompts", async () => {
        const result = await client.listPrompts();
        const names = new Set(result.prompts.map((p) => p.name));
        for (const expected of EXPECTED_PROMPT_NAMES) {
            expect(names.has(expected), `expected prompt ${expected}`).toBe(true);
        }
        expect(result.prompts).toHaveLength(EXPECTED_PROMPT_NAMES.length);
    });

    it("each prompt exposes a non-empty title and description", async () => {
        const result = await client.listPrompts();
        for (const p of result.prompts) {
            expect(p.title?.length ?? 0, `prompt ${p.name} title`).toBeGreaterThan(0);
            expect(p.description?.length ?? 0, `prompt ${p.name} description`).toBeGreaterThan(0);
        }
    });

    it("prompt templates match manifest.json exactly (single source of truth, no drift)", async () => {
        const manifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            prompts: Array<{ name: string; description: string; arguments: string[]; text: string }>;
        };
        expect(manifest.prompts.map((p) => p.name).sort()).toEqual(
            [...EXPECTED_PROMPT_NAMES].sort(),
        );

        const listed = await client.listPrompts();
        for (const entry of manifest.prompts) {
            // Manifest description must match the registered prompt's description.
            const registered = listed.prompts.find((p) => p.name === entry.name);
            expect(registered, `prompt ${entry.name} registered`).toBeDefined();
            expect(registered!.description).toBe(entry.description);

            // Rendering the prompt with a sentinel argument must reproduce the
            // manifest template with its `${arg}` placeholder substituted.
            expect(entry.arguments).toHaveLength(1);
            const argName = entry.arguments[0]!;
            const sentinel = "قيمة-اختبارية";
            const rendered = await client.getPrompt({
                name: entry.name,
                arguments: { [argName]: sentinel },
            });
            expect(rendered.messages).toHaveLength(1);
            const msg = rendered.messages[0]!;
            expect(msg.role).toBe("user");
            expect(msg.content.type).toBe("text");
            const expected = entry.text.replaceAll("${" + argName + "}", sentinel);
            expect((msg.content as { type: "text"; text: string }).text).toBe(expected);
        }
    });

    it("shamela_search_pages('الكلام', book=9942) returns 9 hits via the protocol", async () => {
        const result = await client.callTool({
            name: "shamela_search_pages",
            arguments: {
                query: "الكلام",
                scope: { book_ids: [FIXTURE_BOOK_ID] },
                limit: 20,
                offset: 0,
                response_format: "json",
            },
        });
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as { total_hits: number };
        expect(sc.total_hits).toBe(9);
    });

    it("shamela_get_book(9942) returns the canonical book name", async () => {
        const result = await client.callTool({
            name: "shamela_get_book",
            arguments: { book_id: FIXTURE_BOOK_ID, response_format: "json" },
        });
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as { book_name: string };
        expect(sc.book_name).toBe("الأصول من علم الأصول");
    });

    it("returns isError=true for malformed input (missing required field)", async () => {
        const result = await client.callTool({
            name: "shamela_search_pages",
            arguments: {
                // missing required `query` — Zod input validation should reject.
            },
        });
        expect(result.isError).toBe(true);
    });

    it("returns isError=true for an unknown book_id", async () => {
        const result = await client.callTool({
            name: "shamela_get_book",
            arguments: { book_id: 999_999_999, response_format: "json" },
        });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
        expect(text).toContain("BOOK_NOT_FOUND");
    });

    // ----------------------------------------------------------------------
    // Round-trip every tool through the MCP protocol. Each test invokes one
    // tool with valid arguments anchored to the fixture book (9942) so the
    // tool wrapper, Zod validation, dependency wiring, and renderer are all
    // exercised end-to-end. Tools whose result depends on what the user has
    // installed (tafseer, hadith) accept either success or a clean
    // SERVICE_KEY_NOT_FOUND, mirroring the smoke convention.
    // ----------------------------------------------------------------------
    describe("core tools round-trip via MCP protocol", () => {
        it("shamela_search_titles", async () => {
            const r = (await client.callTool({
                name: "shamela_search_titles",
                arguments: {
                    query: "الكلام",
                    scope: { book_ids: [FIXTURE_BOOK_ID] },
                    limit: 10,
                    offset: 0,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { total_hits: number };
            expect(sc.total_hits).toBeGreaterThanOrEqual(1);
        });

        it("shamela_search_books", async () => {
            const r = (await client.callTool({
                name: "shamela_search_books",
                arguments: { query: "علم", limit: 5, offset: 0, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            expect((r.structuredContent as { total_hits: number }).total_hits).toBeGreaterThanOrEqual(1);
        });

        it("shamela_search_authors", async () => {
            const r = (await client.callTool({
                name: "shamela_search_authors",
                arguments: { query: "ابن", limit: 5, offset: 0, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            expect((r.structuredContent as { total_hits: number }).total_hits).toBeGreaterThanOrEqual(1);
        });

        it("shamela_get_page", async () => {
            const r = (await client.callTool({
                name: "shamela_get_page",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    page_id: 17,
                    keep_html: false,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { body: string; next_page_id: number };
            expect(sc.body.length).toBeGreaterThan(0);
            expect(sc.next_page_id).toBe(18);
        });

        it("shamela_get_toc (subtree mode)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_toc",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    parent_id: 0,
                    depth: 1,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { titles: Array<{ title_id: number; title_text: string }> };
            expect(sc.titles).toHaveLength(23);
        });

        it("shamela_get_toc (ancestor-chain mode)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_toc",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    parent_id: 0,
                    depth: 1,
                    containing_page_id: 17,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as {
                mode: string;
                ancestor_chain: Array<{ title_id: number }>;
            };
            expect(sc.mode).toBe("ancestor_chain");
            expect(sc.ancestor_chain.length).toBeGreaterThanOrEqual(1);
        });

        it("shamela_get_author (author_id from fixture book)", async () => {
            const catalog = await getCatalog();
            const book = catalog.bookRecord(FIXTURE_BOOK_ID)!;
            const authorId = book.main_author!;
            const r = (await client.callTool({
                name: "shamela_get_author",
                arguments: {
                    author_id: authorId,
                    include_books: true,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { books: Array<{ book_id: number }> };
            expect(sc.books.some((b) => b.book_id === FIXTURE_BOOK_ID)).toBe(true);
        });

        it("shamela_list_categories", async () => {
            const r = (await client.callTool({
                name: "shamela_list_categories",
                arguments: { include_counts: true, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { total: number };
            expect(sc.total).toBeGreaterThan(0);
        });

        it("shamela_resolve", async () => {
            const r = (await client.callTool({
                name: "shamela_resolve",
                arguments: {
                    query: "ابن عثيمين",
                    type: "any",
                    limit: 5,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as {
                authors: Array<unknown>;
                books: Array<unknown>;
            };
            expect(sc.authors.length + sc.books.length).toBeGreaterThan(0);
        });

        it("shamela_get_pages_range", async () => {
            const r = (await client.callTool({
                name: "shamela_get_pages_range",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    start_page_id: 1,
                    count: 5,
                    keep_html: false,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { pages: Array<{ body: string }> };
            expect(sc.pages).toHaveLength(5);
            expect(sc.pages.every((p) => p.body.length > 0)).toBe(true);
        });

        it("shamela_get_book_section (chained from get_toc)", async () => {
            const tocR = (await client.callTool({
                name: "shamela_get_toc",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    parent_id: 0,
                    depth: 1,
                    response_format: "json",
                },
            })) as CallResult;
            const titleId = (tocR.structuredContent as {
                titles: Array<{ title_id: number }>;
            }).titles[0]!.title_id;

            const r = (await client.callTool({
                name: "shamela_get_book_section",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    title_id: titleId,
                    max_pages: 30,
                    keep_html: false,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { pages: Array<unknown> };
            expect(sc.pages.length).toBeGreaterThanOrEqual(1);
        });

        it("shamela_get_citation (style=shamela)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_citation",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    page_id: 17,
                    style: "shamela",
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { formatted: string };
            expect(sc.formatted.startsWith("«الأصول")).toBe(true);
        });

        it("shamela_get_citation (style=full has notes)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_citation",
                arguments: {
                    book_id: FIXTURE_BOOK_ID,
                    page_id: 17,
                    style: "full",
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { notes: string[] };
            expect(sc.notes.length).toBeGreaterThanOrEqual(1);
        });

        it("shamela_search_quran", async () => {
            const r = (await client.callTool({
                name: "shamela_search_quran",
                arguments: {
                    query: "الرحمن",
                    limit: 5,
                    offset: 0,
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { total_hits: number };
            expect(sc.total_hits).toBeGreaterThanOrEqual(1);
        });

        it("shamela_get_aya (aya_id=1)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_aya",
                arguments: { aya_id: 1, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { aya_id: number; body?: string };
            expect(sc.aya_id).toBe(1);
        });

        it("shamela_get_aya (surah=1, aya=1)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_aya",
                arguments: { surah: 1, aya: 1, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            expect((r.structuredContent as { aya_id: number }).aya_id).toBe(1);
        });

        it("shamela_get_tafseer_of_aya (success or SERVICE_KEY_NOT_FOUND)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_tafseer_of_aya",
                arguments: { aya_id: 1, downloaded_only: false, response_format: "json" },
            })) as CallResult;
            if (r.isError) {
                expect(errText(r)).toContain("SERVICE_KEY_NOT_FOUND");
            } else {
                const sc = r.structuredContent as { total: number };
                expect(typeof sc.total).toBe("number");
            }
        });

        it("shamela_list_tafsirs_for_aya (never errors for a valid aya; tri-state statuses)", async () => {
            const r = (await client.callTool({
                name: "shamela_list_tafsirs_for_aya",
                arguments: { surah: 2, aya: 255, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as {
                aya_id: number;
                totals: {
                    indexed_covers: number;
                    indexed_no_entry_for_this_aya: number;
                    not_indexed_coverage_unknown: number;
                };
                note: string;
                books: Array<{ book_id: number; status: string; page_id: number | null }>;
            };
            expect(sc.aya_id).toBe(262); // 2:255 = ayat al-kursi
            expect(typeof sc.totals.indexed_covers).toBe("number");
            expect(typeof sc.totals.indexed_no_entry_for_this_aya).toBe("number");
            expect(typeof sc.totals.not_indexed_coverage_unknown).toBe("number");
            expect(sc.note.length).toBeGreaterThan(0);
            const allowed = new Set([
                "indexed_covers",
                "indexed_no_entry_for_this_aya",
                "not_indexed_coverage_unknown",
            ]);
            for (const b of sc.books) {
                expect(allowed.has(b.status), `unexpected status ${b.status}`).toBe(true);
                if (b.status === "indexed_covers") expect(b.page_id).not.toBeNull();
                else expect(b.page_id).toBeNull();
            }
        });

        it("shamela_get_tafseer_texts (structure + honest statuses; no text without an index entry)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_tafseer_texts",
                arguments: { surah: 2, aya: 255, max_sources: 2, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as {
                aya_id: number;
                total_indexed: number;
                fetched: number;
                note: string;
                sources: Array<{
                    book_id: number;
                    book_name: string;
                    status: string;
                    text: string;
                    page_id: number | null;
                }>;
            };
            expect(sc.aya_id).toBe(262);
            expect(typeof sc.total_indexed).toBe("number");
            expect(sc.fetched).toBeLessThanOrEqual(2);
            expect(sc.note.length).toBeGreaterThan(0);
            for (const s of sc.sources) {
                if (s.status === "ok") {
                    // Text is only ever attached to an indexed, downloaded source.
                    expect(s.page_id).not.toBeNull();
                    expect(s.text.length).toBeGreaterThan(0);
                } else {
                    expect(s.text).toBe("");
                }
            }
            // The fixture library may lack tafseer.db index entries entirely —
            // an empty sources list with total_indexed=0 is a clean outcome.
            if (sc.total_indexed === 0) expect(sc.sources).toHaveLength(0);
        });

        it("shamela_get_tafseer_texts (requested unindexed book gets a status row, never text)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_tafseer_texts",
                arguments: {
                    surah: 2,
                    aya: 255,
                    book_ids: [FIXTURE_BOOK_ID], // usul work, not a tafsir in the index
                    response_format: "json",
                },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as {
                sources: Array<{ book_id: number; status: string; text: string; note: string | null }>;
            };
            const row = sc.sources.find((s) => s.book_id === FIXTURE_BOOK_ID);
            expect(row).toBeDefined();
            expect(["not_indexed", "no_entry_for_this_aya"]).toContain(row!.status);
            expect(row!.text).toBe("");
            expect(row!.note?.length ?? 0).toBeGreaterThan(0);
        });

        it("shamela_get_books_for_hadith (success or SERVICE_KEY_NOT_FOUND)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_books_for_hadith",
                arguments: { hadith_key: 1, downloaded_only: false, response_format: "json" },
            })) as CallResult;
            if (r.isError) {
                expect(errText(r)).toContain("SERVICE_KEY_NOT_FOUND");
            } else {
                expect(r.structuredContent).toBeDefined();
            }
        });

        it("shamela_list_downloaded_books", async () => {
            // The fixture book is not necessarily in the first page on a large
            // library (ids are sorted ascending), so page through until found.
            type Out = {
                books: Array<{ book_id: number }>;
                has_more: boolean;
                next_offset?: number;
            };
            let offset = 0;
            let found = false;
            for (let page = 0; page < 20; page++) {
                const r = (await client.callTool({
                    name: "shamela_list_downloaded_books",
                    arguments: { limit: 100, offset, response_format: "json" },
                })) as CallResult;
                expect(r.isError, errText(r)).toBeFalsy();
                const sc = r.structuredContent as Out;
                if (sc.books.some((b) => b.book_id === FIXTURE_BOOK_ID)) {
                    found = true;
                    break;
                }
                if (!sc.has_more || sc.next_offset === undefined) break;
                offset = sc.next_offset;
            }
            expect(found, `fixture book ${FIXTURE_BOOK_ID} not in downloaded list`).toBe(true);
        });

        it("shamela_get_book_parts (single-volume fixture)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_book_parts",
                arguments: { book_id: FIXTURE_BOOK_ID, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { is_multi_volume: boolean; total_pages: number };
            expect(sc.is_multi_volume).toBe(false);
            expect(sc.total_pages).toBeGreaterThan(0);
        });

        it("shamela_get_page_services (no services on fixture page)", async () => {
            const r = (await client.callTool({
                name: "shamela_get_page_services",
                arguments: { book_id: FIXTURE_BOOK_ID, page_id: 17, response_format: "json" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            const sc = r.structuredContent as { has_services: boolean };
            expect(sc.has_services).toBe(false);
        });

        it("markdown rendering produces text content", async () => {
            const r = (await client.callTool({
                name: "shamela_list_categories",
                arguments: { include_counts: true, response_format: "markdown" },
            })) as CallResult;
            expect(r.isError, errText(r)).toBeFalsy();
            expect(r.content[0]!.text.startsWith("#")).toBe(true);
        });
    });
});

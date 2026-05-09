/**
 * shamela-mcp v0.0.1 — MCP server entry point.
 *
 * Spins up a Java helper subprocess on first tool call, exposes three tools
 * over stdio MCP transport, and forwards each tool call as a JSON-line
 * request to the helper.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Catalog } from "./catalog.js";
import { Helper, HelperError } from "./helper.js";
import { PageStore } from "./pages.js";
import { resolveAll, ShamelaNotFoundError } from "./paths.js";
import { searchAuthors, searchAuthorsInput } from "./tools/searchAuthors.js";
import { searchBooks, searchBooksInput } from "./tools/searchBooks.js";
import { searchPages, searchPagesInput } from "./tools/searchPages.js";
// @ts-expect-error — esbuild `--loader:.wasm=binary` inlines this as a Uint8Array.
import sqlWasm from "sql.js/dist/sql-wasm.wasm";

const SQL_WASM_BINARY: Uint8Array = sqlWasm as unknown as Uint8Array;
const VERSION = "0.0.1";

function logInfo(msg: string): void {
    process.stderr.write(`[shamela-mcp] ${msg}\n`);
}

function formatError(err: unknown): string {
    if (err instanceof ShamelaNotFoundError) return err.message;
    if (err instanceof HelperError) return `${err.code}: ${err.message}`;
    if (err instanceof Error) return err.message;
    return String(err);
}

interface Backend {
    helper: Helper;
    catalog: Catalog;
    pages: PageStore;
}

async function main(): Promise<void> {
    let backend: Backend | null = null;

    const getBackend = async (): Promise<Backend> => {
        if (backend) return backend;
        const paths = await resolveAll();
        logInfo(`install root: ${paths.installRoot}`);
        logInfo(`jre:          ${paths.jre}`);
        logInfo(`jars:         ${paths.jars.length} files`);
        logInfo(`helper jar:   ${paths.helperJar}`);

        const masterDb = (await import("node:path")).join(paths.database, "master.db");
        const catalog = await Catalog.load(masterDb, SQL_WASM_BINARY);
        logInfo(`catalog:      ${catalog.bookCount()} books, ${catalog.authorCount()} authors`);
        const pages = new PageStore(paths.database, SQL_WASM_BINARY);

        const h = new Helper({ paths });
        await h.ready(20_000);
        backend = { helper: h, catalog, pages };
        return backend;
    };

    const server = new McpServer(
        { name: "shamela", version: VERSION },
        { capabilities: { tools: {} } },
    );

    server.tool(
        "shamela_search_pages",
        "Search Maktabah al-Shamela's downloaded book pages for an Arabic phrase. Searches both the body (matn / المتن) and footnotes (الحواشي) of every page you have downloaded in Shamela. Multiple words are AND-combined; each word can match in either field. Arabic normalization is applied: diacritics removed, alef variants merged (ٱآأإ→ا), ya merged (ى→ي), waw merged (ؤ→و), ta-marbuta to ha (ة→ه). Each hit returns the book name, author, printed-page label (e.g. \"17\" or \"ج 1/ 45\"), and a snippet with <mark> around matches. Results are NOT relevance-ranked; they come back in Lucene index order.",
        searchPagesInput,
        async (args, _extra) => {
            try {
                const b = await getBackend();
                const result = await searchPages(b.helper, b.catalog, b.pages, args as { query: string; max_results: number });
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                return {
                    isError: true,
                    content: [{ type: "text", text: formatError(err) }],
                };
            }
        },
    );

    server.tool(
        "shamela_search_books",
        "Search Shamela's catalog of books by name, author name, or bibliography text. Works even when no books are downloaded — the book index ships pre-populated. Returns book id, name, author, and a snippet from the bibliography.",
        searchBooksInput,
        async (args, _extra) => {
            try {
                const b = await getBackend();
                const result = await searchBooks(b.helper, b.catalog, args as { query: string; max_results: number });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
                return { isError: true, content: [{ type: "text", text: formatError(err) }] };
            }
        },
    );

    server.tool(
        "shamela_search_authors",
        "Search Shamela's catalog of authors by name or biography. Works even when no books are downloaded — the author index ships pre-populated. Returns author id, name, Hijri death year (when known), and a snippet from the biography.",
        searchAuthorsInput,
        async (args, _extra) => {
            try {
                const b = await getBackend();
                const result = await searchAuthors(b.helper, b.catalog, args as { query: string; max_results: number });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
                return { isError: true, content: [{ type: "text", text: formatError(err) }] };
            }
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo(`shamela-mcp v${VERSION} ready`);

    // Clean shutdown on stdio close.
    const shutdown = () => {
        backend?.helper.close();
        backend?.pages.close();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    void z;
}

main().catch((err) => {
    process.stderr.write(`[shamela-mcp] fatal: ${formatError(err)}\n`);
    process.exit(1);
});

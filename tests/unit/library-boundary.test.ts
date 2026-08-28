/**
 * The library boundary, exercised the way a host exercises it.
 *
 * `registerAllTools` is the whole public API: a host brings its own MCP server
 * and answers three questions — where the install is, how to read its SQLite,
 * how to reach the search engine — and gets the tool set. Everything here is
 * stubbed, deliberately: no Shamela install, no sql.js, no JVM. If any of the
 * thirty-four tools reached past the injected dependencies for a file path, a
 * wasm binary or a subprocess, this file is where that shows up, because there
 * is nothing behind them to reach.
 *
 * This is the same shape the remote server uses, so a break here is a break
 * there. And because it stubs everything, it runs as a unit test: CI has no
 * Shamela install and no JVM, and this is the one contract another repository
 * builds on — it has to be guarded where every pull request is checked, not
 * only on a maintainer's machine.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, registerAllTools } from "../../src/server/index.js";
import type { Helper, ShamelaDb, ShamelaPaths, SqlStatement } from "../../src/server/index.js";

/** Every tool this build registers. The count is asserted, not assumed. */
const EXPECTED_TOOL_COUNT = 34;

const FAKE_PATHS: ShamelaPaths = {
    installRoot: "/nowhere/shamela",
    installRootSource: "setting",
    database: "/nowhere/shamela/database",
    jre: "/nowhere/shamela/jre/bin/java",
    jars: [],
    helperJar: "/nowhere/helper.jar",
    engineGeneration: "2",
};

/** A statement over rows the stub decided to hand back. */
function statement(rows: Array<Array<string | number | null>>): SqlStatement {
    let i = -1;
    return {
        bind: () => {
            i = -1;
        },
        step: () => ++i < rows.length,
        get: () => rows[i] ?? [],
        reset: () => {
            i = -1;
        },
        free: () => {},
    };
}

/**
 * A `ShamelaDb` with no SQLite behind it at all — three categories in
 * master.db and nothing else. Enough to prove the catalogue was read through
 * the injected driver rather than through sql.js.
 */
let opened: string[] = [];
const stubDb: ShamelaDb = {
    async open(filePath: string) {
        opened.push(filePath);
        if (!filePath.endsWith("master.db")) return null;
        return {
            prepare(sql: string) {
                if (sql.includes("FROM category")) {
                    return statement([
                        [1, "الفقه", 1],
                        [2, "التفسير", 2],
                        [3, "الحديث", 3],
                    ]);
                }
                return statement([]);
            },
            close() {},
        };
    },
};

let helperCalls = 0;
const stubHelper: Helper = {
    request: async <T>() => {
        helperCalls++;
        return {} as T;
    },
    ping: async () => ({ pong: true as const, java_version: "stub" }),
    ready: async () => ({ pong: true as const, java_version: "stub" }),
    close: () => {},
};

let client: Client;
let server: McpServer;
let pathsResolved = 0;

beforeAll(async () => {
    server = createMcpServer();
    registerAllTools(server, {
        resolvePaths: async () => {
            pathsResolved++;
            return FAKE_PATHS;
        },
        db: stubDb,
        createHelper: () => stubHelper,
        log: () => {},
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "library-boundary-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
}, 30_000);

describe("registerAllTools", () => {
    it("registers the whole tool set on a server the caller owns", async () => {
        const { tools } = await client.listTools();
        expect(tools.length).toBe(EXPECTED_TOOL_COUNT);
        expect(tools.map((t) => t.name).filter((n) => !n.startsWith("shamela_"))).toEqual([]);
    });

    it("touches nothing environment-specific until a tool is actually called", () => {
        // Registration must not resolve paths, open a database or start a
        // helper: a host whose library is missing still has to be able to
        // start, connect, and say so through shamela_health.
        expect(pathsResolved).toBe(0);
        expect(opened).toEqual([]);
        expect(helperCalls).toBe(0);
    });

    it("reads the catalogue through the injected driver", async () => {
        const r = (await client.callTool({
            name: "shamela_list_categories",
            arguments: { response_format: "json" },
        })) as {
            isError?: boolean;
            structuredContent?: { categories?: Array<{ category_id: number; category_name: string }> };
        };

        expect(r.isError ?? false).toBe(false);
        expect(r.structuredContent?.categories?.map((c) => c.category_name)).toEqual([
            "الفقه",
            "التفسير",
            "الحديث",
        ]);
        // And it got there by asking the injected driver for master.db under
        // the injected install path — not by finding one of its own.
        expect(opened.some((p) => p.includes("master.db") && p.includes("/nowhere/shamela"))).toBe(true);
    });

    it("declares the same schemas whichever host registers them", async () => {
        // The wire contract belongs to this repository, not to the host: the
        // input schema a remote client sees must be the one the extension's
        // client sees, `additionalProperties` and all.
        const { tools } = await client.listTools();
        const getPage = tools.find((t) => t.name === "shamela_get_page");
        expect(getPage?.inputSchema).toMatchObject({
            type: "object",
            additionalProperties: false,
            required: ["book_id", "page_id"],
        });
    });
});

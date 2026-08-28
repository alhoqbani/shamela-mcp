/**
 * The desktop extension's entry point — and the first consumer of the library.
 *
 * Everything below this file is host-agnostic. Everything host-specific about
 * the extension is here and nowhere else: the Shamela install is on the user's
 * own disk (`resolveAll`), SQLite is sql.js with the WebAssembly binary inlined
 * into the bundle, the search engine is a Java subprocess we spawn, and the
 * transport is stdio because Claude Desktop launches us as a child process.
 *
 * The `.wasm` import is the reason this file exists separately from
 * `index.ts`. Only esbuild can resolve it (`--loader:.wasm=binary`), so any
 * module that carries it can only be loaded through the bundler — which is
 * fine for the one file the bundle starts at, and was not fine while it sat in
 * the middle of the shared code, where it forced the test runner to stub `.wasm`
 * imports and would have forced the same on every other consumer.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "./constants.js";
import { formatErrorMessage } from "./errors.js";
import { JavaHelper } from "./helper.js";
import { logInfo } from "./backend.js";
import { pathToFileURL } from "node:url";
import { resolveAll } from "./paths.js";
import { createMcpServer, countRegistered, registerAllTools } from "./register.js";
import { createSqlJsDb } from "./sqljs.js";

// @ts-expect-error — esbuild `--loader:.wasm=binary` inlines this as a Uint8Array.
import sqlWasm from "sql.js/dist/sql-wasm.wasm";

const SQL_WASM_BINARY: Uint8Array = sqlWasm as unknown as Uint8Array;

/** Stdio entry point — used when this file is invoked directly. */
async function main(): Promise<void> {
    const server = createMcpServer();
    const backend = registerAllTools(server, {
        resolvePaths: resolveAll,
        db: createSqlJsDb(SQL_WASM_BINARY),
        createHelper: (paths) => new JavaHelper({ paths }),
        log: logInfo,
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logInfo(
        `shamela-mcp v${VERSION} ready (${countRegistered(server).tools} tools + ${countRegistered(server).resources} resources registered)`,
    );

    // Cold-start fix (#14): warm the JVM + indexes right after the MCP
    // handshake (not on first tool call). Non-blocking — the handshake already
    // completed above, so a slow warm-up never trips the client's init timeout;
    // if it fails, the next tool call falls back to lazy init.
    void backend
        .get()
        .then(() => logInfo("backend warmed (JVM + indexes ready)"))
        .catch((e) => logInfo(`warm-up deferred to first call: ${formatErrorMessage(e)}`));

    process.on("SIGTERM", () => backend.close());
    process.on("SIGINT", () => backend.close());
}

// Only run main() when this module is the process entry point (tsx, node dist/index.js).
// Importing it from a test must not auto-start the server.
const isEntry = ((): boolean => {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();
if (isEntry) {
    main().catch((err) => {
        process.stderr.write(`[shamela-mcp] fatal: ${formatErrorMessage(err)}\n`);
        process.exit(1);
    });
}

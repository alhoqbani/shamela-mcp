/**
 * The sql.js implementation of `ShamelaDb` — what the desktop extension ships.
 *
 * sql.js is SQLite compiled to WebAssembly. It needs that `.wasm` binary
 * handed to it, and where the binary comes from differs per host: the bundled
 * extension inlines it at build time (esbuild's `--loader:.wasm=binary`), the
 * test suite reads it off disk. So this module takes the bytes and never
 * decides where they came from — which is also what keeps the `.wasm` import
 * out of every module that merely reads rows.
 *
 * Reading is genuinely read-only: sql.js is handed a COPY of the file's bytes
 * and has no path to write back, so nothing here can touch the user's library.
 */

import * as fs from "node:fs";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import type { ShamelaDb, SqlDatabase } from "./db.js";

/** sql.js wants an ArrayBuffer; a Node Buffer is a view into a larger one. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view.buffer as ArrayBuffer;
    }
    return view.slice().buffer as ArrayBuffer;
}

/**
 * Build a `ShamelaDb` backed by sql.js.
 *
 * The wasm module is initialised once, lazily, on the first open — startup
 * pays for it only if something is actually read.
 */
export function createSqlJsDb(wasmBinary: Uint8Array): ShamelaDb {
    let sql: SqlJsStatic | null = null;
    let initPromise: Promise<SqlJsStatic> | null = null;

    const ensureInit = async (): Promise<SqlJsStatic> => {
        if (sql) return sql;
        // Cache the promise, not the result: two concurrent opens must share
        // one initialisation of the wasm module.
        if (!initPromise) {
            initPromise = initSqlJs({ wasmBinary: toArrayBuffer(wasmBinary) }).then((s) => {
                sql = s;
                return s;
            });
        }
        return initPromise;
    };

    return {
        async open(filePath: string): Promise<SqlDatabase | null> {
            if (!fs.existsSync(filePath)) return null;
            const bytes = fs.readFileSync(filePath);
            const SQL = await ensureInit();
            return new SQL.Database(new Uint8Array(bytes));
        },
    };
}

/**
 * The one interface every SQLite read in this server goes through.
 *
 * Three kinds of file are read: the catalogue (`master.db`), one file per
 * downloaded book (`book/<bucket>/<id>.db`), and the service indexes
 * (`service/{tafseer,hadeeth,trajim}.db`). All of them used to be opened by
 * calling sql.js directly from `catalog.ts`, `pages.ts` and `services.ts`,
 * which made sql.js — and its WebAssembly binary — a hard requirement of the
 * tool layer. It is not one: the tool layer needs rows, not a particular
 * SQLite driver.
 *
 * So the driver is injected. The extension supplies the sql.js implementation
 * in `sqljs.ts` (see `createSqlJsDb`); a host that already has a native driver
 * supplies its own without importing sql.js or any `.wasm` at all.
 *
 * The shape is deliberately the cursor sql.js already exposes — prepare, bind,
 * step, get, reset, free — because that is what the call sites are written
 * against and translating them to a row-array API would be a rewrite of code
 * this refactor has no business touching. It is small enough to implement over
 * any driver: better-sqlite3, for instance, backs one `SqlStatement` with
 * `stmt.raw().iterate(params)` and advances that iterator on `step()`.
 *
 * Every implementation MUST open read-only. Shamela's files belong to Shamela.
 */

/** A single column value, exactly as sql.js reports it. */
export type SqlValue = number | string | Uint8Array | null;

/**
 * A prepared statement, used as a cursor:
 *
 *   const stmt = db.prepare("SELECT a, b FROM t WHERE c = ?");
 *   try {
 *       stmt.bind([42]);
 *       while (stmt.step()) { const [a, b] = stmt.get(); }
 *   } finally {
 *       stmt.free();
 *   }
 */
export interface SqlStatement {
    /** Bind parameters and rewind. Called again (after `reset`) to re-run. */
    bind(values?: SqlValue[]): void;
    /** Advance to the next row. False when the result set is exhausted. */
    step(): boolean;
    /** The current row, one entry per selected column. */
    get(): SqlValue[];
    /** Rewind so the statement can be bound and stepped again. */
    reset(): void;
    /** Release the statement. Callers always do this in a `finally`. */
    free(): void;
}

/** An open, read-only handle on one SQLite file. */
export interface SqlDatabase {
    prepare(sql: string): SqlStatement;
    close(): void;
}

/**
 * Opens Shamela's SQLite files. The single environment-specific dependency of
 * everything that is not the Java search helper.
 */
export interface ShamelaDb {
    /**
     * Open `filePath` read-only.
     *
     * Returns null when the file is not there — a book that was never
     * downloaded and a service index the install does not ship are ordinary
     * states, not failures, and every caller already treats them as "no data".
     * Throws when the file exists and cannot be read: a truncated or corrupt
     * catalogue is a real fault and saying "not found" about it sends the
     * reader looking in the wrong place.
     */
    open(filePath: string): Promise<SqlDatabase | null>;
}

/**
 * The backend — everything a tool call needs behind it — and the environment
 * it is built from.
 *
 * A tool handler wants a catalogue, a page store, a service store, a verse
 * index and a search helper. Where those come from is the one thing that
 * differs between hosts: the desktop extension reads a Shamela install on the
 * user's own disk with sql.js and spawns Java itself, while a remote host has
 * its own copy of the library, its own SQLite driver, and may run the helper
 * somewhere else entirely. `ShamelaDeps` is that difference, and the whole of
 * it: where the install is, how to read SQLite, how to reach the helper.
 *
 * `createBackendProvider` turns those three answers into a `BackendProvider`
 * that builds the backend once, lazily, and keeps it in step with a library
 * the user is still downloading into.
 */

import * as path from "node:path";

import { AyaIndexStore } from "./ayaIndex/store.js";
import { Catalog } from "./catalog.js";
import type { ShamelaDb } from "./db.js";
import { engineTooOld } from "./errors.js";
import { CatalogFreshness } from "./freshness.js";
import type { Helper } from "./helper.js";
import { PageStore } from "./pages.js";
import type { ShamelaPaths } from "./paths.js";
import { ServiceStore } from "./services.js";

/** Where this server's own diagnostics go when the host does not say. */
export function logInfo(msg: string): void {
    process.stderr.write(`[shamela-mcp] ${msg}\n`);
}

export interface Backend {
    helper: Helper;
    catalog: Catalog;
    pages: PageStore;
    services: ServiceStore;
    /** Verse→page indexes built from each tafsir's own chapter titles. */
    ayaIndex: AyaIndexStore;
    /** Needed to re-read master.db when the library changes mid-session. */
    paths: ShamelaPaths;
}

/**
 * What could be built, when the whole backend could not be.
 *
 * Everything here except the helper is SQLite, and SQLite loads on installs the
 * JVM helper refuses to run on. Diagnosis needs those parts and does not need
 * the helper, so this returns them with the reason the rest is missing.
 */
export interface PartialBackend {
    catalog: Catalog | null;
    pages: PageStore | null;
    paths: ShamelaPaths | null;
    /** Why the full backend could not be built. */
    startupError: unknown;
}

/**
 * Everything environment-specific, and nothing else. A host supplies these
 * three answers and gets the full tool set; no tool knows which host it is
 * running in.
 */
export interface ShamelaDeps {
    /**
     * Locate the Shamela installation. Called once, on first use — never at
     * registration time, so a server whose library is missing still starts and
     * can say so through `shamela_health`.
     */
    resolvePaths: () => Promise<ShamelaPaths>;
    /** How to open Shamela's SQLite files. See `db.ts`. */
    db: ShamelaDb;
    /** How to reach the search engine for this install. See `helper.ts`. */
    createHelper: (paths: ShamelaPaths) => Helper;
    /** Diagnostics sink. Defaults to this server's own stderr line format. */
    log?: (msg: string) => void;
    /** How long to wait for the helper's first response. */
    readyTimeoutMs?: () => number;
}

/**
 * The backend's lifetime, owned by the caller: `get` per tool call, `partial`
 * when `get` failed and `shamela_health` still has to explain why, `close` at
 * shutdown.
 */
export interface BackendProvider {
    get(): Promise<Backend>;
    partial(startupError: unknown): Promise<PartialBackend>;
    close(): void;
}

/**
 * How long to wait for the Java helper's first response.
 *
 * The default covers a cold JVM start on ordinary hardware, but the reports of
 * first-call timeouts all came from slower machines, so it is adjustable
 * without rebuilding: set SHAMELA_READY_TIMEOUT_MS.
 */
export function readyTimeoutMs(log: (msg: string) => void = logInfo): number {
    const raw = process.env.SHAMELA_READY_TIMEOUT_MS?.trim();
    if (!raw) return 20_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        log(`ignoring SHAMELA_READY_TIMEOUT_MS=${raw} (want a number of milliseconds, at least 1000)`);
        return 20_000;
    }
    return Math.min(parsed, 300_000);
}

/** Build the long-lived backend (paths, catalog, page/service stores, helper). */
export async function createBackend(deps: ShamelaDeps): Promise<Backend> {
    const log = deps.log ?? logInfo;
    const paths = await deps.resolvePaths();
    log(`install root: ${paths.installRoot}`);
    log(`jre:          ${paths.jre}`);
    log(`jars:         ${paths.jars.length} files`);
    log(`helper jar:   ${paths.helperJar}`);

    const masterDb = path.join(paths.database, "master.db");
    const catalog = await Catalog.load(masterDb, deps.db, { databaseRoot: paths.database });
    log(
        `catalog:      ${catalog.bookCount()} books, ${catalog.authorCount()} authors, ${catalog.categoryCount()} categories`,
    );
    const pages = new PageStore(paths.database, deps.db);
    const services = new ServiceStore(paths.database, deps.db);

    // Check the engine generation BEFORE launching Java. The helper is compiled
    // against the Java that current Shamela builds ship, so on an older install
    // the JVM refuses to load it and exits with a bare code 1 — which reads as
    // "the extension crashed" and sends people hunting in the wrong place.
    if (paths.engineGeneration === "1") {
        log(`engine:       generation 1 — too old for this helper`);
        throw engineTooOld(paths.installRoot);
    }
    log(`engine:       generation ${paths.engineGeneration}`);

    const h = deps.createHelper(paths);
    await h.ready((deps.readyTimeoutMs ?? (() => readyTimeoutMs(log)))());
    const ayaIndex = new AyaIndexStore(paths.database, pages);
    return { helper: h, catalog, pages, services, ayaIndex, paths };
}

/**
 * Rebuild as much as possible after createBackend failed, for shamela_health.
 *
 * Deliberately repeats createBackend's early steps rather than sharing them: a
 * diagnostic that goes through the same code path as the thing it is
 * diagnosing fails in the same place and reports nothing.
 */
export async function createPartialBackend(
    deps: ShamelaDeps,
    startupError: unknown,
): Promise<PartialBackend> {
    let paths: ShamelaPaths | null = null;
    let catalog: Catalog | null = null;
    let pages: PageStore | null = null;
    try {
        paths = await deps.resolvePaths();
        const masterDb = path.join(paths.database, "master.db");
        catalog = await Catalog.load(masterDb, deps.db, { databaseRoot: paths.database });
        pages = new PageStore(paths.database, deps.db);
    } catch {
        // Whatever was reached is what health reports; the rest stays null and
        // the caller says so.
    }
    return { catalog, pages, paths, startupError };
}

/**
 * The standard lifetime: build once, reuse, and notice when the user downloads
 * something while the session is open.
 */
export function createBackendProvider(deps: ShamelaDeps): BackendProvider {
    const log = deps.log ?? logInfo;
    // Cache the PROMISE, not the resolved value: the warm-up and any tool call
    // arriving during the ~12 s JVM cold start must share ONE initialization.
    // Caching the value instead would let both observe `null` and each spawn a
    // full backend (two JVMs, one leaked at shutdown, first call still slow).
    let backendPromise: Promise<Backend> | null = null;
    let backendRef: Backend | null = null; // resolved reference for close()
    let freshness: CatalogFreshness | null = null;

    const get = async (): Promise<Backend> => {
        if (!backendPromise) {
            backendPromise = createBackend(deps).then(
                (b) => {
                    backendRef = b;
                    return b;
                },
                (e) => {
                    backendPromise = null; // failed init must not poison later calls
                    throw e;
                },
            );
        }
        const b = await backendPromise;

        // The library can change while the session is open — the user goes and
        // downloads the book we just recommended. Check here, at the single
        // place every handler passes through, and nowhere else.
        if (!freshness) {
            freshness = new CatalogFreshness({
                masterDbPath: path.join(b.paths.database, "master.db"),
                databaseRoot: b.paths.database,
                db: deps.db,
                log,
            });
        }
        const catalog = await freshness.ensureFresh(b.catalog);
        if (catalog === b.catalog) return b;

        // Cached SQLite handles hold a byte image of files Shamela may have
        // just rewritten, so they go with the old catalog.
        b.pages.invalidate();
        b.services.invalidate();
        b.ayaIndex.invalidate();

        // The page text itself comes from Shamela's Lucene indexes, which the
        // helper opened when it started. Ask it to pick up what Shamela has
        // committed since; until that succeeds, books found mid-session are
        // listed but explicitly not readable rather than silently empty.
        if (catalog.sessionDiscoveredIds().length > 0) {
            try {
                const res = await b.helper.request<{ reopened?: string[] }>("reopen", {});
                log(`search indexes reopened: ${(res.reopened ?? []).join(", ") || "no change"}`);
                catalog.clearSessionDiscovered();
            } catch (e) {
                log(`could not reopen the search indexes: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        const refreshed: Backend = { ...b, catalog };
        backendRef = refreshed;
        backendPromise = Promise.resolve(refreshed);
        return refreshed;
    };

    return {
        get,
        partial: (startupError: unknown) => createPartialBackend(deps, startupError),
        close: () => {
            void backendRef?.helper.close();
            backendRef?.pages.close();
            backendRef?.services.close();
        },
    };
}

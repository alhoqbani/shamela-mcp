/**
 * shamela-mcpb v0.0.1 smoke test (Windows). Runs without Claude Desktop.
 *
 * Spawns the Java helper directly through the Helper class, runs five
 * canonical queries, and asserts the expected hit counts. Exits 0 on
 * all-pass, 1 with diagnostic on any failure.
 *
 * Expected counts (book 9942 downloaded; matches MAC-VALIDATION.md §3 of
 * the source-investigation repo):
 *   shamela_search_pages "المنطق"      -> 0
 *   shamela_search_pages "الكلام"      -> 9
 *   shamela_search_pages "الكلام لغة"   -> 3
 *   shamela_search_books "علم"          -> >= 1   (loose check)
 *   shamela_search_authors "ابن"        -> >= 1   (loose check)
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

import { Catalog } from "../src/server/catalog.js";
import { Helper } from "../src/server/helper.js";
import { PageStore } from "../src/server/pages.js";
import { resolveAll, ShamelaNotFoundError } from "../src/server/paths.js";
import { searchAuthors } from "../src/server/tools/searchAuthors.js";
import { searchBooks } from "../src/server/tools/searchBooks.js";
import { searchPages } from "../src/server/tools/searchPages.js";

function fmt(label: string, value: string): string {
    return `${label.padEnd(15)}${value}`;
}

async function main(): Promise<number> {
    console.log("=".repeat(70));
    console.log("shamela-mcpb v0.0.1 smoke test");
    console.log(fmt("Node:", `${process.version}`));
    console.log(fmt("Platform:", `${process.platform} ${process.arch}`));
    console.log("=".repeat(70));

    let paths;
    try {
        paths = await resolveAll();
    } catch (err) {
        if (err instanceof ShamelaNotFoundError) {
            console.error(err.message);
        } else {
            console.error("Failed to resolve Shamela paths:", (err as Error).message);
        }
        return 1;
    }
    console.log(fmt("install root:", paths.installRoot));
    console.log(fmt("database:", paths.database));
    console.log(fmt("jre:", paths.jre));
    console.log(fmt("helper jar:", paths.helperJar));
    console.log(fmt("jars:", `${paths.jars.length} files`));
    console.log();

    if (!fs.existsSync(paths.helperJar)) {
        console.error(`Helper jar not built: ${paths.helperJar}`);
        console.error("Run: npm run build:java   (or  .\\scripts\\build-java.ps1)");
        return 1;
    }
    if (!fs.existsSync(path.join(paths.database, "store", "page", "segments_7"))) {
        console.error("page index appears empty (no segments file).");
        console.error("Open Shamela and download at least one book before running this smoke test.");
        return 1;
    }

    // In dev mode (tsx) we read sql.js's WASM from node_modules; in production
    // it is inlined into dist/index.js by esbuild's binary loader.
    const sqlWasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const sqlWasm = new Uint8Array(fs.readFileSync(sqlWasmPath));

    const helper = new Helper({ paths });
    const catalog = await Catalog.load(path.join(paths.database, "master.db"), sqlWasm);
    const pageStore = new PageStore(paths.database, sqlWasm);
    console.log(fmt("catalog:", `${catalog.bookCount()} books, ${catalog.authorCount()} authors`));
    const failures: string[] = [];

    try {
        const ping = await helper.ready(20_000);
        console.log(fmt("Java:", ping.java_version));
        console.log();

        const pageCases: Array<{ query: string; expected: number }> = [
            { query: "المنطق", expected: 0 },
            { query: "الكلام", expected: 9 },
            { query: "الكلام لغة", expected: 3 },
        ];
        for (const tc of pageCases) {
            const r = await searchPages(helper, catalog, pageStore, { query: tc.query, max_results: 20 });
            const ok = r.total_hits === tc.expected;
            console.log(
                `[${ok ? "OK" : "FAIL"}] search_pages query=${JSON.stringify(tc.query)} ` +
                    `normalized=${JSON.stringify(r.normalized_tokens)} ` +
                    `total_hits=${r.total_hits} expected=${tc.expected} returned=${r.returned}`,
            );
            if (r.results.length > 0) {
                const head = r.results[0];
                console.log(
                    `       first: book=${head.book_id} (${head.book_name.slice(0, 40)}) ` +
                        `page=${head.page_id} printed=${JSON.stringify(head.printed_page)} ` +
                        `matched=${JSON.stringify(head.matched_in)}`,
                );
            }
            if (!ok) failures.push(`search_pages "${tc.query}": got ${r.total_hits}, expected ${tc.expected}`);
        }

        const booksResult = await searchBooks(helper, catalog, { query: "علم", max_results: 5 });
        const booksOk = booksResult.total_hits >= 1;
        console.log(
            `[${booksOk ? "OK" : "FAIL"}] search_books query="علم" total_hits=${booksResult.total_hits} returned=${booksResult.returned}`,
        );
        if (booksResult.results.length > 0) {
            const head = booksResult.results[0];
            console.log(`       first: book=${head.book_id} (${head.book_name.slice(0, 50)}) author=${head.author_name}`);
        }
        if (!booksOk) failures.push(`search_books "علم": got ${booksResult.total_hits}, expected >= 1`);

        const authorsResult = await searchAuthors(helper, catalog, { query: "ابن", max_results: 5 });
        const authorsOk = authorsResult.total_hits >= 1;
        console.log(
            `[${authorsOk ? "OK" : "FAIL"}] search_authors query="ابن" total_hits=${authorsResult.total_hits} returned=${authorsResult.returned}`,
        );
        if (authorsResult.results.length > 0) {
            const head = authorsResult.results[0];
            console.log(
                `       first: author=${head.author_id} (${head.author_name}) death=${head.death_year}`,
            );
        }
        if (!authorsOk) failures.push(`search_authors "ابن": got ${authorsResult.total_hits}, expected >= 1`);
    } catch (err) {
        failures.push(`uncaught: ${(err as Error).message}`);
    } finally {
        await helper.close();
        pageStore.close();
    }

    console.log();
    if (failures.length === 0) {
        console.log("All smoke checks passed.");
        return 0;
    }
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error("smoke test crashed:", err);
        process.exit(1);
    });

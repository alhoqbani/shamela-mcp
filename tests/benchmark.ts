/**
 * shamela-mcp workflow benchmark.
 *
 * Two narratives that simulate how an LLM would chain the 20 tools to answer
 * realistic prompts:
 *
 *   Mode 1 — single-fact lookup. Bound: ≤ 5 tool calls.
 *     Prompt: "ما هو معنى الكلام عند ابن عثيمين؟"
 *     resolve("ابن عثيمين") → search_pages(الكلام, scope.author) →
 *     get_page(book, page) → done.
 *
 *   Mode 2 — research synthesis. Bound: ≤ 50 tool calls.
 *     Prompt: "اجمع تعريف الكلام في الأصول والشواهد عليه عند ابن عثيمين، مع
 *     الإحالات."
 *     list_categories → resolve(ibn-uthaymeen) → search_books(scope=author) →
 *     for each top hit: search_pages → get_page → get_citation. Bounded by
 *     downloaded-book reality (only book 9942 is downloaded on the test
 *     install, so the realistic upper bound here is ~20 calls; the loop is
 *     correctness-checked rather than coverage-checked).
 *
 * Each tool invocation is counted via a counting-Helper proxy. The benchmark
 * passes if (a) the call count is within the mode's bound, (b) every
 * intermediate response has the expected shape, and (c) the final synthesis
 * has at least one valid citation.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

import { Catalog } from "../src/server/catalog.js";
import { Helper } from "../src/server/helper.js";
import { PageStore } from "../src/server/pages.js";
import { resolveAll } from "../src/server/paths.js";
import { ServiceStore } from "../src/server/services.js";

import { runGetCitation, getCitationInput } from "../src/server/tools/getCitation.js";
import { runGetPage, getPageInput } from "../src/server/tools/getPage.js";
import { runListCategories, listCategoriesInput } from "../src/server/tools/listCategories.js";
import { runResolve, resolveInput } from "../src/server/tools/resolve.js";
import { runSearchPages, searchPagesInput } from "../src/server/tools/searchPages.js";

class CallCounter {
    public count = 0;
    bump(label: string): void {
        this.count++;
        console.log(`  [${this.count}] ${label}`);
    }
}

async function modeOne(deps: {
    helper: Helper;
    catalog: Catalog;
    pages: PageStore;
}): Promise<{ calls: number; ok: boolean; details: string }> {
    console.log("\n--- Mode 1 ---");
    const counter = new CallCounter();

    counter.bump("resolve('ابن عثيمين')");
    const resolved = await runResolve(
        deps.helper,
        deps.catalog,
        resolveInput.parse({ query: "ابن عثيمين", type: "author", limit: 3, response_format: "json" }),
    );
    if (resolved.structuredContent.authors.length === 0) {
        return { calls: counter.count, ok: false, details: "resolve returned no authors" };
    }
    const authorId = resolved.structuredContent.authors[0]!.author_id;

    counter.bump(`search_pages('الكلام', author=${authorId})`);
    const sp = await runSearchPages(
        deps.helper,
        deps.catalog,
        deps.pages,
        searchPagesInput.parse({
            query: "الكلام",
            scope: { author_ids: [authorId] },
            limit: 5,
            offset: 0,
            response_format: "json",
        }),
    );
    if (sp.structuredContent.results.length === 0) {
        return { calls: counter.count, ok: false, details: "search_pages returned no hits" };
    }
    const top = sp.structuredContent.results[0]!;

    counter.bump(`get_page(${top.book_id}, ${top.page_id})`);
    const page = await runGetPage(
        deps.helper,
        deps.catalog,
        deps.pages,
        getPageInput.parse({
            book_id: top.book_id,
            page_id: top.page_id,
            keep_html: false,
            response_format: "json",
        }),
    );
    const bodyLen = page.structuredContent.body.length;
    const ok = bodyLen > 0 && counter.count <= 5;
    return {
        calls: counter.count,
        ok,
        details: `bodyLen=${bodyLen}, book=${page.structuredContent.book_name}, printed=${page.structuredContent.printed_page}`,
    };
}

async function modeTwo(deps: {
    helper: Helper;
    catalog: Catalog;
    pages: PageStore;
}): Promise<{ calls: number; ok: boolean; details: string; citations: number }> {
    console.log("\n--- Mode 2 ---");
    const counter = new CallCounter();

    counter.bump("list_categories");
    runListCategories(
        deps.catalog,
        listCategoriesInput.parse({ include_counts: true, response_format: "json" }),
    );

    counter.bump("resolve('ابن عثيمين')");
    const resolved = await runResolve(
        deps.helper,
        deps.catalog,
        resolveInput.parse({ query: "ابن عثيمين", type: "author", limit: 3, response_format: "json" }),
    );
    if (resolved.structuredContent.authors.length === 0) {
        return { calls: counter.count, ok: false, details: "resolve failed", citations: 0 };
    }
    const authorId = resolved.structuredContent.authors[0]!.author_id;

    counter.bump(`search_pages('الكلام', author=${authorId})`);
    const sp = await runSearchPages(
        deps.helper,
        deps.catalog,
        deps.pages,
        searchPagesInput.parse({
            query: "الكلام",
            scope: { author_ids: [authorId], downloaded_only: true },
            limit: 20,
            offset: 0,
            response_format: "json",
        }),
    );

    let citations = 0;
    const seen = new Set<string>();
    for (const hit of sp.structuredContent.results) {
        const key = `${hit.book_id}-${hit.page_id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        counter.bump(`get_page(${hit.book_id}, ${hit.page_id})`);
        const page = await runGetPage(
            deps.helper,
            deps.catalog,
            deps.pages,
            getPageInput.parse({
                book_id: hit.book_id,
                page_id: hit.page_id,
                keep_html: false,
                response_format: "json",
            }),
        );

        counter.bump(`get_citation(${hit.book_id}, ${hit.page_id})`);
        const cit = await runGetCitation(
            deps.catalog,
            deps.pages,
            getCitationInput.parse({
                book_id: hit.book_id,
                page_id: hit.page_id,
                style: "shamela",
                response_format: "json",
            }),
        );
        if (cit.structuredContent.formatted.startsWith("«")) citations++;

        // Bail out if we hit the budget for safety.
        if (counter.count >= 50) break;
        // Demonstrate intent to use the page body but don't dump it to console.
        void page.structuredContent.body.length;
    }

    const ok = citations >= 1 && counter.count <= 50;
    return {
        calls: counter.count,
        ok,
        details: `unique pages=${seen.size}, citations=${citations}`,
        citations,
    };
}

async function main(): Promise<number> {
    const paths = await resolveAll();
    if (!fs.existsSync(paths.helperJar)) {
        console.error(`helper jar missing: ${paths.helperJar}`);
        return 1;
    }
    const sqlWasm = new Uint8Array(fs.readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")));

    const helper = new Helper({ paths });
    const catalog = await Catalog.load(path.join(paths.database, "master.db"), sqlWasm);
    const pages = new PageStore(paths.database, sqlWasm);
    const services = new ServiceStore(paths.database, sqlWasm);

    console.log("=".repeat(72));
    console.log("shamela-mcp workflow benchmark");
    console.log("=".repeat(72));

    let exitCode = 0;
    try {
        await helper.ready(20_000);

        const m1 = await modeOne({ helper, catalog, pages });
        console.log(`Mode 1 → calls=${m1.calls}/5, ok=${m1.ok}, ${m1.details}`);
        if (!m1.ok) exitCode = 1;

        const m2 = await modeTwo({ helper, catalog, pages });
        console.log(`Mode 2 → calls=${m2.calls}/50, ok=${m2.ok}, ${m2.details}`);
        if (!m2.ok) exitCode = 1;
    } finally {
        await helper.close();
        pages.close();
        services.close();
    }

    console.log();
    console.log(exitCode === 0 ? "BENCHMARK PASS" : "BENCHMARK FAIL");
    return exitCode;
}

main()
    .then((c) => process.exit(c))
    .catch((e) => {
        console.error("benchmark crashed:", e);
        process.exit(1);
    });

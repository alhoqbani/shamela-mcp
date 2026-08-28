import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/smoke.ts", "tests/benchmark.ts", "node_modules", "dist"],
        // Lucene queries can be slow on first run; the JVM cold-start is in beforeAll.
        testTimeout: 30_000,
        hookTimeout: 60_000,
        // Share module state across test files so fixtures/shared.ts can cache
        // the JVM helper, catalog, and sql.js wasm. Without this, every
        // integration test file would pay a 3-5s JVM cold-start.
        isolate: false,
        fileParallelism: false,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/server/**/*.ts"],
            exclude: ["src/server/entry.ts"],
        },
    },
});

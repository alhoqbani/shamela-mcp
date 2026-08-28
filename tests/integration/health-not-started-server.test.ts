/**
 * The #42 fix, driven the way a client drives it.
 *
 * The unit test beside this one calls runHealth directly, which proved the
 * report is composed correctly and proved nothing about whether anyone can
 * read it. Two things only this test can see:
 *
 *   - The declared output schema is published with `additionalProperties:
 *     false`, so a field the tool returns without declaring makes the CALL
 *     fail. `startup_error` exists only on the not-started branch, which no
 *     schema check ever reached — the diagnostic would have been rejected in
 *     exactly the situation it was written for.
 *   - The wiring itself: the try/catch around getBackend and the fallback to
 *     createPartialBackend live in the tool handler. Deleting the whole catch
 *     block left the suite green.
 *
 * No Shamela install is needed: the backend factory throws on purpose, and
 * createPartialBackend swallows its own failures.
 */
import { describe, it, expect, beforeAll } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPartialBackend } from "../../src/server/backend.js";
import { createServer } from "../../src/server/index.js";
import { engineTooOld } from "../../src/server/errors.js";
import { resolveAll } from "../../src/server/paths.js";
import { getDb } from "../fixtures/shared.js";

let client: Client;

beforeAll(async () => {
    // The failure a user with an un-upgraded Shamela actually hits: the backend
    // will not build, and the health tool falls back to the partial one — the
    // real partial one, reading this machine's own install through sql.js,
    // because a stub here would test the fallback wiring against nothing.
    const server = createServer(
        async () => {
            throw engineTooOld("C:/shamela4");
        },
        (startupError) =>
            createPartialBackend(
                { resolvePaths: resolveAll, db: getDb(), createHelper: () => { throw startupError; } },
                startupError,
            ),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "health-not-started-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    // Populates the client's output-schema validator cache; without this the
    // response is never validated and the test cannot see the defect.
    await client.listTools();
}, 60_000);

describe("shamela_health over the protocol when the backend cannot be built", () => {
    it("returns the diagnosis instead of being rejected by its own schema", async () => {
        const r = (await client.callTool({ name: "shamela_health", arguments: {} })) as {
            isError?: boolean;
            structuredContent?: {
                status?: string;
                startup_error?: { code?: string; install_root?: string | null };
            };
            content?: Array<{ type: string; text?: string }>;
        };

        expect(r.isError ?? false).toBe(false);
        expect(r.structuredContent?.status).toBe("not_started");
        expect(r.structuredContent?.startup_error?.code).toBe("ENGINE_TOO_OLD");
        // install_root is the folder the diagnosis FOUND, not the one echoed
        // from the error — which is the more useful of the two and is why this
        // is asserted by shape rather than by value: on a machine with Shamela
        // it is that machine's path, and on one without it is null.
        const root = r.structuredContent?.startup_error?.install_root;
        expect(root === null || (typeof root === "string" && root.length > 0)).toBe(true);
        // And the reader gets the reason in prose, not only as a field.
        expect(r.content?.[0]?.text ?? "").toContain("C:/shamela4");
    }, 30_000);

    it("the guide still answers too — it needs no backend at all", async () => {
        // The other tool a stuck user reaches for. If this ever starts touching
        // the backend, it joins the thirty that cannot answer.
        const r = (await client.callTool({ name: "shamela_guide", arguments: {} })) as {
            isError?: boolean;
            content?: Array<{ type: string; text?: string }>;
        };
        expect(r.isError ?? false).toBe(false);
        expect((r.content?.[0]?.text ?? "").length).toBeGreaterThan(200);
    }, 30_000);

    it("every other tool still fails, and says why", async () => {
        // The fix must not have quietly made unrelated tools pretend to work.
        const r = (await client.callTool({
            name: "shamela_search_pages",
            arguments: { query: "الكلام" },
        })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        expect(r.isError).toBe(true);
        expect(r.content?.[0]?.text ?? "").toContain("ENGINE_TOO_OLD");
    }, 30_000);
});

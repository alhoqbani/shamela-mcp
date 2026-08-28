/**
 * The manifest and the server have to agree about what this extension offers.
 *
 * They are written separately: the manifest is what the installer and the
 * extension settings page read, the server is what actually registers tools. A
 * tool added to one and not the other is invisible where it matters — either
 * missing from the listing a user sees, or advertised and then absent when
 * called. Nothing compared them until now.
 *
 * Names and count only. The descriptions differ deliberately — the manifest's
 * are Arabic and user-facing, the server's are English and written for the
 * model choosing between tools — so comparing those would fail on purpose.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { OUTPUT_SCHEMAS } from "../../src/server/outputSchemas.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8")) as {
    tools?: Array<{ name: string; description?: string }>;
    prompts?: unknown[];
};

/** Tool names the server registers, read from the source rather than run. */
function registeredToolNames(): string[] {
    const src = fs.readFileSync(path.join(repoRoot, "src", "server", "register.ts"), "utf8");
    return [...src.matchAll(/server\.registerTool\(\s*\n?\s*"(shamela_[a-z_]+)"/g)].map((m) => m[1]!);
}

describe("manifest ↔ server", () => {
    it("declares exactly the tools the server registers", () => {
        const declared = new Set((manifest.tools ?? []).map((t) => t.name));
        const registered = new Set(registeredToolNames());
        expect(registered.size).toBeGreaterThan(0);

        const missingFromManifest = [...registered].filter((n) => !declared.has(n));
        const missingFromServer = [...declared].filter((n) => !registered.has(n));
        expect(missingFromManifest, `registered but not in manifest: ${missingFromManifest.join(", ")}`).toEqual([]);
        expect(missingFromServer, `in manifest but not registered: ${missingFromServer.join(", ")}`).toEqual([]);
    });

    it("gives every manifest tool a description", () => {
        for (const t of manifest.tools ?? []) {
            expect(t.description?.trim(), `${t.name} has no description`).toBeTruthy();
        }
    });

    it("declares no prompts", () => {
        // Removed deliberately: the client's prompt-injection check rejects MCP
        // prompts and cannot be tested from here, so the surface is gone
        // entirely. This catches a well-meaning reintroduction.
        expect(manifest.prompts ?? []).toEqual([]);
    });

    it("has an output schema for each declared tool", () => {
        const missing = (manifest.tools ?? []).map((t) => t.name).filter((n) => !(n in OUTPUT_SCHEMAS));
        expect(missing, `no declared output shape: ${missing.join(", ")}`).toEqual([]);
    });
});

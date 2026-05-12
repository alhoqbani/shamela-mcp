import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveJre } from "../../src/server/paths.js";

function makeJavaStub(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const javaPath = path.join(dir, "java");
    fs.writeFileSync(javaPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return javaPath;
}

describe("resolveJre — macOS bundled JRE discovery", () => {
    let tmpRoot: string;
    let savedEnvJre: string | undefined;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shamela-paths-"));
        savedEnvJre = process.env.SHAMELA_JRE;
        delete process.env.SHAMELA_JRE;
    });

    afterEach(() => {
        if (savedEnvJre === undefined) delete process.env.SHAMELA_JRE;
        else process.env.SHAMELA_JRE = savedEnvJre;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("finds the JRE under app/mac/arm64 on Apple Silicon installs", () => {
        const expected = makeJavaStub(
            path.join(tmpRoot, "app", "mac", "arm64", "jre", "2", "bin"),
        );
        expect(resolveJre(tmpRoot, "darwin")).toBe(expected);
    });

    it("finds the JRE under app/mac/x86_64 on Intel Mac installs", () => {
        const expected = makeJavaStub(
            path.join(tmpRoot, "app", "mac", "x86_64", "jre", "2", "bin"),
        );
        expect(resolveJre(tmpRoot, "darwin")).toBe(expected);
    });

    it("still finds the JRE under the legacy app/mac/64 path", () => {
        const expected = makeJavaStub(
            path.join(tmpRoot, "app", "mac", "64", "jre", "2", "bin"),
        );
        expect(resolveJre(tmpRoot, "darwin")).toBe(expected);
    });

    it("prefers arm64 when both arm64 and x86_64 are present", () => {
        const arm = makeJavaStub(
            path.join(tmpRoot, "app", "mac", "arm64", "jre", "2", "bin"),
        );
        makeJavaStub(path.join(tmpRoot, "app", "mac", "x86_64", "jre", "2", "bin"));
        expect(resolveJre(tmpRoot, "darwin")).toBe(arm);
    });

    it("throws and lists every probed path when no JRE is found", () => {
        expect(() => resolveJre(tmpRoot, "darwin")).toThrow(/arm64.*x86_64.*64/s);
    });

    it("honours SHAMELA_JRE when set, even if a bundled JRE exists", () => {
        makeJavaStub(path.join(tmpRoot, "app", "mac", "arm64", "jre", "2", "bin"));
        const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "shamela-override-"));
        try {
            const override = makeJavaStub(overrideDir);
            process.env.SHAMELA_JRE = override;
            expect(resolveJre(tmpRoot, "darwin")).toBe(override);
        } finally {
            fs.rmSync(overrideDir, { recursive: true, force: true });
        }
    });
});

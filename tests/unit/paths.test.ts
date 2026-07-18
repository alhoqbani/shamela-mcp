import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveJars, resolveJre } from "../../src/server/paths.js";

function makeJavaStub(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const javaPath = path.join(dir, "java");
    fs.writeFileSync(javaPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return javaPath;
}

// Best-effort temp cleanup: on Windows, AV/indexer scans can hold a fresh
// temp dir beyond the rmSync retry window (EPERM). Isolation doesn't depend
// on deletion — every test creates a unique mkdtemp dir — so a leftover dir
// in the OS temp folder is harmless and the OS reclaims it.
function rmBestEffort(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* tolerated: Windows file-lock race */
    }
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
        rmBestEffort(tmpRoot);
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
            rmBestEffort(overrideDir);
        }
    });
});

describe("resolveJre — legacy jre/1 version folder (older installs, issue #4)", () => {
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
        rmBestEffort(tmpRoot);
    });

    function makeJavaExeStub(dir: string): string {
        fs.mkdirSync(dir, { recursive: true });
        const javaPath = path.join(dir, "java.exe");
        fs.writeFileSync(javaPath, "");
        return javaPath;
    }

    it("falls back to app/win/64/jre/1 when jre/2 is absent (Windows)", () => {
        const expected = makeJavaExeStub(
            path.join(tmpRoot, "app", "win", "64", "jre", "1", "bin"),
        );
        expect(resolveJre(tmpRoot, "win32")).toBe(expected);
    });

    it("prefers jre/2 over jre/1 when both exist (Windows)", () => {
        const v2 = makeJavaExeStub(path.join(tmpRoot, "app", "win", "64", "jre", "2", "bin"));
        makeJavaExeStub(path.join(tmpRoot, "app", "win", "64", "jre", "1", "bin"));
        expect(resolveJre(tmpRoot, "win32")).toBe(v2);
    });

    it("falls back to app/mac/arm64/jre/1 when jre/2 is absent (macOS)", () => {
        const expected = makeJavaStub(
            path.join(tmpRoot, "app", "mac", "arm64", "jre", "1", "bin"),
        );
        expect(resolveJre(tmpRoot, "darwin")).toBe(expected);
    });

    it("lists both jre/2 and jre/1 candidates in the not-found error", () => {
        expect(() => resolveJre(tmpRoot, "win32")).toThrow(/jre[\\/]2.*jre[\\/]1/s);
    });
});

describe("resolveJars — lucene version folder fallback (issue #4)", () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shamela-paths-"));
    });

    afterEach(() => {
        rmBestEffort(tmpRoot);
    });

    function makeJar(dir: string, name: string): string {
        fs.mkdirSync(dir, { recursive: true });
        const jarPath = path.join(dir, name);
        fs.writeFileSync(jarPath, "");
        return jarPath;
    }

    it("finds jars under app/lucene/2", () => {
        const jar = makeJar(path.join(tmpRoot, "app", "lucene", "2"), "lucene-core.jar");
        expect(resolveJars(tmpRoot)).toEqual([jar]);
    });

    it("falls back to app/lucene/1 when lucene/2 is absent", () => {
        const jar = makeJar(path.join(tmpRoot, "app", "lucene", "1"), "lucene-core.jar");
        expect(resolveJars(tmpRoot)).toEqual([jar]);
    });

    it("prefers lucene/2 over lucene/1 when both exist", () => {
        const v2 = makeJar(path.join(tmpRoot, "app", "lucene", "2"), "lucene-core.jar");
        makeJar(path.join(tmpRoot, "app", "lucene", "1"), "lucene-core.jar");
        expect(resolveJars(tmpRoot)).toEqual([v2]);
    });

    it("lists both probed lucene paths in the not-found error", () => {
        expect(() => resolveJars(tmpRoot)).toThrow(/lucene[\\/]2.*lucene[\\/]1/s);
    });
});

/**
 * Manage the long-lived Java helper subprocess.
 *
 * Spawns `java -cp <classpath> ws.shamela.mcp.Main`, talks to it via newline-
 * delimited JSON on stdin/stdout. Tracks in-flight requests by id; routes
 * responses back. Restarts the helper once on first crash; fails fast on
 * second crash. Pipes helper stderr to our own stderr (Claude Desktop
 * captures it as logs).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";

import type { ShamelaPaths } from "./paths.js";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    cmd: string;
}

interface HelperResponse {
    id: string;
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
}

const RESTART_LIMIT = 1;

export interface HelperConfig {
    paths: ShamelaPaths;
    /** Extra JVM args (e.g. -Xmx512m). Passed before -cp. */
    jvmArgs?: string[];
    /** Where to write helper's stderr. Defaults to process.stderr. */
    stderrSink?: NodeJS.WritableStream;
}

export class HelperError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = "HelperError";
    }
}

export class Helper extends EventEmitter {
    private readonly config: HelperConfig;
    private child: ChildProcessWithoutNullStreams | null = null;
    private buffer = "";
    private pending = new Map<string, PendingRequest>();
    private crashCount = 0;
    private dead = false;
    private starting: Promise<void> | null = null;

    constructor(config: HelperConfig) {
        super();
        this.config = config;
    }

    /** Spawn the helper process if not already running. */
    private async start(): Promise<void> {
        if (this.dead) {
            throw new HelperError("HELPER_DEAD", "Helper crashed too many times; not restarting.");
        }
        if (this.child && !this.child.killed) return;
        if (this.starting) return this.starting;

        const promise = new Promise<void>((resolve, reject) => {
            const { paths } = this.config;
            const classpath = [...paths.jars, paths.helperJar].join(path.delimiter);
            // Java 21 + Lucene 10.4 wants these to silence two startup warnings
            // and enable SIMD vector acceleration. Both are no-ops without effect
            // on correctness.
            const defaultJvmArgs = [
                "--enable-native-access=ALL-UNNAMED",
                "--add-modules=jdk.incubator.vector",
            ];
            const args = [
                ...defaultJvmArgs,
                ...(this.config.jvmArgs ?? []),
                "-cp",
                classpath,
                "ws.shamela.mcp.Main",
                paths.installRoot,
            ];
            try {
                const child = spawn(paths.jre, args, {
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                });
                this.child = child;
                this.buffer = "";

                child.stdout.setEncoding("utf8");
                child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

                const sink = this.config.stderrSink ?? process.stderr;
                child.stderr.setEncoding("utf8");
                child.stderr.on("data", (chunk: string) => sink.write(`[helper stderr] ${chunk}`));

                child.once("error", (err) => {
                    reject(err);
                });
                child.once("exit", (code, signal) => this.handleExit(code, signal));

                // Helper signals readiness by emitting a single "ready" line on stdout.
                // We treat the first response we get from a subsequent ping as ready,
                // but for robustness, also resolve start once spawn() succeeded — the
                // caller still has to await ping() before sending real work.
                resolve();
            } catch (err) {
                reject(err as Error);
            }
        });

        this.starting = promise;
        try {
            await promise;
        } finally {
            this.starting = null;
        }
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            this.handleLine(line);
        }
    }

    private handleLine(line: string): void {
        let parsed: HelperResponse;
        try {
            parsed = JSON.parse(line) as HelperResponse;
        } catch {
            // Malformed line — surface to stderr so we can debug, but don't crash.
            process.stderr.write(`[helper stdout-malformed] ${line}\n`);
            return;
        }
        const pending = this.pending.get(parsed.id);
        if (!pending) {
            // Unknown id — likely a delayed response after timeout. Drop.
            return;
        }
        this.pending.delete(parsed.id);
        if (parsed.ok) {
            pending.resolve(parsed.data ?? null);
        } else {
            const code = parsed.error?.code ?? "HELPER_ERROR";
            const message = parsed.error?.message ?? "Unknown helper error";
            pending.reject(new HelperError(code, message));
        }
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        const child = this.child;
        this.child = null;
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        const isExpected = child?.killed ?? false;

        if (!isExpected) {
            this.crashCount += 1;
            this.emit("crash", { reason, crashCount: this.crashCount });
            if (this.crashCount > RESTART_LIMIT) {
                this.dead = true;
            }
        }

        // Reject all pending requests so callers don't hang.
        const err = new HelperError(
            this.dead ? "HELPER_DEAD" : "HELPER_DIED",
            `Java helper exited (${reason}). ${
                this.dead ? "Crashed too many times; not restarting." : "Will restart on next request."
            }`,
        );
        for (const pending of this.pending.values()) {
            pending.reject(err);
        }
        this.pending.clear();
    }

    /** Send a command and wait for a response. */
    async request<T = unknown>(cmd: string, args: unknown = {}, timeoutMs = 60_000): Promise<T> {
        await this.start();
        const child = this.child;
        if (!child || child.killed) {
            throw new HelperError("HELPER_DEAD", "Helper is not running.");
        }

        const id = randomUUID();
        const payload = JSON.stringify({ id, cmd, args }) + "\n";

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (v) => resolve(v as T),
                reject,
                cmd,
            });
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new HelperError("HELPER_TIMEOUT", `Helper did not respond to ${cmd} within ${timeoutMs}ms.`));
                }
            }, timeoutMs);
            // Ensure timer doesn't keep the process alive past server shutdown.
            timer.unref?.();

            child.stdin.write(payload, (err) => {
                if (err) {
                    if (this.pending.delete(id)) {
                        clearTimeout(timer);
                        reject(new HelperError("HELPER_WRITE_ERROR", err.message));
                    }
                }
            });
        });
    }

    /** Ping the helper; resolves with the helper's metadata. */
    ping(timeoutMs = 10_000): Promise<{ pong: true; java_version: string }> {
        return this.request<{ pong: true; java_version: string }>("ping", {}, timeoutMs);
    }

    /** Wait until the helper has answered a ping. */
    async ready(timeoutMs = 15_000): Promise<{ pong: true; java_version: string }> {
        return this.ping(timeoutMs);
    }

    /** Stop the helper subprocess. */
    async close(): Promise<void> {
        const child = this.child;
        if (!child) return;
        this.child = null;
        try {
            child.stdin.end();
        } catch {
            /* ignore */
        }
        // Give the helper a moment to flush stdout, then kill if needed.
        await new Promise((r) => setTimeout(r, 100));
        if (!child.killed) child.kill();
    }
}

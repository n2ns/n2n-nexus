// Run the built CLI (build/index.js, built by the globalSetup tests/setup/go-host.ts) and collect what it printed.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const ENTRY = path.join(REPO, "build", "index.js");

/** How long a CLI may run before runCli ends it, unless the test says otherwise. */
const RUN_TIMEOUT_MS = 60_000;

export type CliOptions = {
    env: NodeJS.ProcessEnv;
    /** Written to stdin, which is then closed; without it stdin is ignored. */
    stdin?: string;
    cwd?: string;
    /** Entry script to run instead of ENTRY. */
    entry?: string;
    /** The CLI is ended and the run rejects when it is still running after this long (default RUN_TIMEOUT_MS). */
    timeoutMs?: number;
};
export type CliResult = { code: number | null; stdout: string; stderr: string; ms: number };

/**
 * The runner's environment for a CLI under test, without the variables of a Claude Code or
 * Codex session the tests may run in that the hook command reads: CLAUDE_CODE_SESSION_ATTENDED
 * and CLAUDE_PID (the background wait) and CODEX_HOME (the conversation's title).
 */
export function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of ["CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID", "CODEX_HOME"]) delete env[name];
    return { ...env, ...extra };
}

/** Start npm fixtures without inherited config, including uppercase aliases from Windows CI. */
export function npmTestEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
}

/** The CLIs runCli started that have not exited. */
const running = new Set<ChildProcess>();
// A test that failed or timed out no longer waits for its CLI, and a background wait asks for up to a day: end it.
afterEach(() => {
    for (const child of running) child.kill("SIGKILL");
    running.clear();
});

/** `<node> <entry> <args>` with process.execPath as node; resolves when it exits. */
export function runCli(args: string[], { env, stdin, cwd, entry = ENTRY, timeoutMs = RUN_TIMEOUT_MS }: CliOptions): Promise<CliResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
        running.add(child);
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`n2n-nexus ${args.join(" ")} was still running after ${timeoutMs} ms and was ended`));
        }, timeoutMs);
        const ended = () => {
            clearTimeout(timer);
            running.delete(child);
        };
        let stdout = "";
        let stderr = "";
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", (error) => { ended(); reject(error); });
        child.on("close", (code) => { ended(); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
        if (stdin !== undefined) child.stdin!.end(stdin);
    });
}

/** runCli, synchronously (no stdin). */
export function runCliSync(args: string[], { env, cwd, entry = ENTRY }: Omit<CliOptions, "stdin" | "timeoutMs">): Omit<CliResult, "ms"> {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

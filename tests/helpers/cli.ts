// Run the built CLI (build/index.js, built by the globalSetup tests/setup/go-host.ts) and collect what it printed.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const ENTRY = path.join(REPO, "build", "index.js");

export type CliOptions = {
    env: NodeJS.ProcessEnv;
    /** Written to stdin, which is then closed; without it stdin is ignored. */
    stdin?: string;
    cwd?: string;
    /** Entry script to run instead of ENTRY. */
    entry?: string;
};
export type CliResult = { code: number | null; stdout: string; stderr: string; ms: number };

/** `<node> <entry> <args>` with process.execPath as node; resolves when it exits. */
export function runCli(args: string[], { env, stdin, cwd, entry = ENTRY }: CliOptions): Promise<CliResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
        if (stdin !== undefined) child.stdin!.end(stdin);
    });
}

/** runCli, synchronously (no stdin). */
export function runCliSync(args: string[], { env, cwd, entry = ENTRY }: Omit<CliOptions, "stdin">): Omit<CliResult, "ms"> {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

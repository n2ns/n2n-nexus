/**
 * Codex runs a hook from hooks.json only once it is trusted: config.toml keeps
 * a `hooks.state.<key>.trusted_hash` per hook, a hash Codex computes from the
 * hook's whole configuration as its own version serializes it, so another
 * Codex version may compute another hash and the value cannot be computed
 * here. Codex's app server reports it instead: `hooks/list` gives each hook's
 * key, current hash and trust status, and `config/value/write` stores the
 * hash, as the CLI's /hooks screen and the app's settings do. The Codex the
 * user runs decides, so the app's own copy is preferred to the one on PATH.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pkg } from "../config/index.js";
import { clientCommand } from "./client-command.js";
import { isOurCodexHook } from "./hook-command.js";

/** One hook as `hooks/list` reports it (the fields used here). */
type ListedHook = { key: string; command?: string; sourcePath?: string; currentHash: string; trustStatus: string };

/** A Codex program to ask, and where it came from (for messages). */
type CodexProgram = { command: string; args: string[]; label: string };

/** Our hooks' trust as one Codex sees it: how many there are, and the keys of those it does not trust. */
type TrustState = { ours: number; untrusted: string[] };

const TIMEOUT_MS = 30_000;

/**
 * The Codex to ask: NEXUS_CODEX_COMMAND when set; on Windows the newest copy
 * the Codex app keeps in %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe;
 * else `codex` on PATH. Null when none can be run.
 */
export function codexProgram(): CodexProgram | null {
    const override = process.env.NEXUS_CODEX_COMMAND;
    if (override) {
        const resolved = clientCommand(override);
        return resolved && { ...resolved, label: override };
    }
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        const bin = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
        let newest: { file: string; time: number } | undefined;
        try {
            for (const build of fs.readdirSync(bin)) {
                const file = path.join(bin, build, "codex.exe");
                const time = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
                if (time !== undefined && (!newest || time > newest.time)) newest = { file, time };
            }
        } catch { /* no Codex app */ }
        if (newest) return { command: newest.file, args: [], label: newest.file };
    }
    const resolved = clientCommand("codex");
    return resolved && { ...resolved, label: "codex" };
}

/**
 * Ask `codex app-server` about our hooks in `hooksFile`
 * and, with `trust`, store the trust of those it does not trust yet. Returns
 * the state afterwards; throws when the app server cannot be used.
 */
export async function codexHookTrust(program: CodexProgram, hooksFile: string, trust: boolean): Promise<TrustState> {
    const child = spawn(program.command, [...program.args, "app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const waiting = new Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>();
    let fail: (error: Error) => void = () => { /* replaced below */ };
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    failure.catch(() => { /* surfaced by the race in call */ });
    child.on("error", (error) => fail(error));
    // A write after the app server closed its input (it crashed) fails here, not as an uncaught error.
    child.stdin.on("error", (error) => fail(error));
    child.on("exit", (code) => fail(new Error(`codex app-server exited (${code})`)));
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let message: { id?: unknown; result?: unknown; error?: { message?: string } };
            try { message = JSON.parse(line); } catch { continue; }
            if (typeof message.id === "number") waiting.get(message.id)?.(message);
        }
    });
    let next = 1;
    const call = async (method: string, params: unknown): Promise<unknown> => {
        const id = next++;
        const answer = new Promise<{ result?: unknown; error?: { message?: string } }>((resolve) => waiting.set(id, resolve));
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        const message = await Promise.race([answer, failure]);
        waiting.delete(id);
        if (message.error) throw new Error(`${method}: ${message.error.message ?? "failed"}`);
        return message.result;
    };
    const file = path.resolve(hooksFile);
    const list = async (): Promise<ListedHook[]> => {
        const result = await call("hooks/list", { cwds: [os.homedir()] }) as { data?: Array<{ hooks?: ListedHook[] }> };
        return (result.data ?? []).flatMap((entry) => entry.hooks ?? [])
            .filter((hook) => typeof hook.sourcePath === "string" && path.resolve(hook.sourcePath) === file && isOurCodexHook(hook.command ?? ""));
    };
    const timer = setTimeout(() => fail(new Error("codex app-server did not answer in time")), TIMEOUT_MS);
    try {
        await call("initialize", { clientInfo: { name: "n2n-nexus", version: pkg.version } });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        let hooks = await list();
        const pending = hooks.filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
        if (trust && pending.length > 0) {
            const state = Object.fromEntries(pending.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
            await call("config/value/write", { keyPath: "hooks.state", mergeStrategy: "upsert", value: state });
            hooks = await list();
        }
        return { ours: hooks.length, untrusted: hooks.filter((hook) => hook.trustStatus !== "trusted").map((hook) => hook.key) };
    } finally {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        child.stdin.end();
        child.kill();
    }
}

/** Why Codex may list none of our hooks, for messages. */
export const NOT_LISTED = "Codex does not list the n2n-nexus hooks: check that hooks are on in Codex's config.toml ([features] hooks)";

/** How to trust the hooks by hand, for messages. */
export const MANUAL_TRUST = "trust the n2n-nexus hooks by hand: in the Codex app's settings (hooks), or with /hooks in the Codex CLI";

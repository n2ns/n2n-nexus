// The pi extension `n2n-nexus install pi` writes (src/cli/pi.ts), loaded in this process with
// pi's ExtensionAPI faked: each hook it runs is the built CLI (`hook pi`) against a test host.
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ENTRY, REPO } from "./cli.js";
import type { Host } from "../conformance/harness.js";
import { renderPiExtension } from "../../src/cli/pi.js";

/** A pi session in `cwd`: the context the extension reads. */
export const ctxOf = (sessionId: string, cwd = "/work/proj") => ({ cwd, sessionManager: { getSessionId: () => sessionId } });
type Ctx = ReturnType<typeof ctxOf>;
type Handler = (event: Record<string, unknown>, ctx: Ctx | undefined) => unknown;
export type FakePi = {
    emit: (name: string, event: Record<string, unknown>, ctx: Ctx | undefined) => Promise<unknown>;
    userMessages: Array<{ text: string; opts: unknown }>;
    customMessages: Array<{ msg: { customType: string; content: string; display: boolean }; opts: unknown }>;
    shutdownCtx: Ctx | undefined;
};

/**
 * Load the extension for this test file (its own folder under tests/tmp) and fake pi around it.
 * `started(id)` starts a pi session as pi does at startup; every session a test started is
 * shut down after the test, before `endSessions` (the agent kit's) runs. `hooks` tells which
 * processes the extension started (each hook it runs and each background wait is one): how
 * many so far, and when all of them have ended.
 */
export function piKit(host: Host, endSessions: () => Promise<void>, folder: string) {
    const tmp = path.join(REPO, "tests", "tmp", folder);
    let register: (pi: unknown) => void = () => { throw new Error("extension not loaded"); };
    const pis: FakePi[] = [];
    const ended: Promise<void>[] = [];
    const codexHome = process.env.CODEX_HOME;

    beforeAll(async () => {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        // The hooks inherit this process's environment: not the Codex state of a session the tests may run in.
        process.env.CODEX_HOME = path.join(tmp, "no-codex-home");
        const file = path.join(tmp, "n2n-nexus.ts");
        fs.writeFileSync(file, renderPiExtension({ node: process.execPath, entry: ENTRY, endpoint: `http://127.0.0.1:${host.port}` }));
        // The extension's own spawn, recorded as it starts each process.
        vi.doMock("node:child_process", () => ({
            ...childProcess,
            spawn: (command: string, args: string[], options: childProcess.SpawnOptions) => {
                const child = childProcess.spawn(command, args, options);
                ended.push(new Promise((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); }));
                return child;
            }
        }));
        const mod = await import(/* @vite-ignore */ file);
        vi.doUnmock("node:child_process");
        register = (pi) => mod.default(pi);
    });
    afterEach(async () => {
        for (const pi of pis.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, pi.shutdownCtx);
        await endSessions();
    });
    afterAll(() => {
        if (codexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = codexHome;
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    const hooks = { started: () => ended.length, done: async () => { await Promise.all(ended); } };

    function fakePi(): FakePi {
        const handlers = new Map<string, Handler[]>();
        const fake: FakePi = {
            userMessages: [],
            customMessages: [],
            shutdownCtx: undefined,
            emit: async (name, event, ctx) => {
                let last: unknown;
                for (const fn of handlers.get(name) ?? []) last = await fn(event, ctx);
                return last;
            },
        };
        register({
            on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
            sendUserMessage(text: string, opts?: unknown) { fake.userMessages.push({ text, opts }); },
            sendMessage(msg: FakePi["customMessages"][number]["msg"], opts?: unknown) { fake.customMessages.push({ msg, opts }); },
        });
        pis.push(fake);
        return fake;
    }

    async function started(sessionId: string): Promise<FakePi> {
        const pi = fakePi();
        pi.shutdownCtx = ctxOf(sessionId);
        await pi.emit("session_start", { reason: "startup" }, ctxOf(sessionId));
        return pi;
    }

    return { started, hooks };
}

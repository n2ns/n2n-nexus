import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DISCOVERY_QUERY, MAX_TITLE_CHARS, WAKE_RETRY_FIRST_DELAY_MS, WAKE_RETRY_MAX_DELAY_MS } from "../src/contract.js";
import { hookClientPid } from "../src/cli/client-process.js";
import { agentapiProgram, nextQueueRetry, waitForWake } from "../src/cli/hook.js";
import { machineInfo } from "../src/cli/machine.js";
import { NexusClient, NexusToolError, NexusTransportError, REQUEST_TIMEOUT_CODE } from "../src/client/nexus-client.js";
import { ENTRY, REPO, cliEnv, runCli, type CliResult } from "./helpers/cli.js";
import { closedPort, listen } from "./helpers/http.js";
import { cleanupExecutables, writeExecutable } from "./helpers/executable.js";

// Tests the built CLI (built by the globalSetup).
const TMP = path.join(REPO, "tests", "tmp", "hook-cli");

function runHook(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}, cwd?: string, entry = ENTRY): Promise<CliResult> {
    // CODEX_HOME points at an empty folder unless a test sets it: never read the user's own Codex state.
    return runCli(["hook", ...args], { env: cliEnv({ NEXUS_ENDPOINT: "", CODEX_HOME: path.join(TMP, "no-codex-home"), ...env }), stdin, cwd, entry });
}

/**
 * The machine a hook run with WSL_DISTRO_NAME=`distro` must report, worked out here and not by
 * the code under test (the host name alone is its own: machine.test.ts covers how it is read).
 */
function expectedMachine(distro: string) {
    let platform: string = process.platform;
    if (platform === "linux") {
        let version = "";
        try {
            version = fs.readFileSync("/proc/version", "utf8");
        } catch {
            // no /proc: plain Linux
        }
        if (/microsoft/i.test(version)) platform = "wsl";
    }
    return { hostname: machineInfo().hostname, platform, environment: platform === "wsl" ? distro : "", utcOffset: 0 - new Date().getTimezoneOffset() };
}

type FakeDaemon = {
    endpoint: string;
    requests: Array<{ url: string; body: unknown }>;
    activeConnections: () => number;
    respond: (body: Record<string, unknown>) => { delayMs?: number; status?: number; raw: string };
    close: () => Promise<void>;
};

async function startFakeDaemon(): Promise<FakeDaemon> {
    const fake: Partial<FakeDaemon> = { requests: [], respond: () => ({ raw: JSON.stringify({ output: null }) }) };
    const sockets = new Set<net.Socket>();
    const replies = new Set<NodeJS.Timeout>();
    const { server, endpoint } = await listen((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            fake.requests!.push({ url: req.url ?? "", body });
            const reply = fake.respond!(body);
            const timer = setTimeout(() => {
                replies.delete(timer);
                if (res.destroyed) return;
                res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
                res.end(reply.raw);
            }, reply.delayMs ?? 0);
            replies.add(timer);
        });
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    fake.activeConnections = () => sockets.size;
    fake.endpoint = endpoint;
    fake.close = () => new Promise<void>((resolve) => {
        for (const timer of replies) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
    return fake as FakeDaemon;
}

async function toolsAnswer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/tools`, { timeout: 1000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => req.destroy());
    });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
}

afterAll(async () => {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("n2n-nexus hook, forwarding", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });

    it("forwards only the contract fields and prints the output as one JSON line", async () => {
        const output = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[n2n-nexus] 1 unread" } };
        fake.respond = () => ({ raw: JSON.stringify({ output }) });
        const stdin = {
            hook_event_name: "PostToolUse", session_id: "s1", cwd: "/work", tool_use_id: "t1", tool_name: "Bash",
            transcript_path: "/tmp/t.jsonl", tool_input: { command: "ls" }, tool_response: { stdout: "x".repeat(10_000) }
        };
        const result = await runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify(stdin), { WSL_DISTRO_NAME: "Test_Distro" });

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(JSON.stringify(output) + "\n");
        expect(fake.requests).toEqual([{
            url: "/api/hook",
            body: { client: "claude", input: { hook_event_name: "PostToolUse", session_id: "s1", cwd: "/work", tool_use_id: "t1", tool_name: "Bash", machine: expectedMachine("Test_Distro") } }
        }]);
    });

    it("forwards Stop and SessionEnd fields for codex", async () => {
        await runHook(["codex", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "c1", stop_hook_active: true, last_assistant_message: "hi" }));
        await runHook(["codex", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "c1", reason: "exit", source: "x" }));
        expect(fake.requests.map((r) => r.body)).toEqual([
            { client: "codex", input: { hook_event_name: "Stop", session_id: "c1", stop_hook_active: true, machine: machineInfo() } },
            { client: "codex", input: { hook_event_name: "SessionEnd", session_id: "c1", source: "x", reason: "exit", machine: machineInfo() } }
        ]);
    });

    it("prints nothing when the output is null", async () => {
        const result = await runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(fake.requests).toHaveLength(1);
    });

    it("prefers --endpoint over NEXUS_ENDPOINT and falls back to NEXUS_ENDPOINT", async () => {
        const stdin = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" });
        await runHook(["claude", "--endpoint", fake.endpoint], stdin, { NEXUS_ENDPOINT: "http://127.0.0.2:1" });
        expect(fake.requests).toHaveLength(1);
        await runHook(["claude"], stdin, { NEXUS_ENDPOINT: fake.endpoint });
        expect(fake.requests).toHaveLength(2);
    });

    it("waits past the short timeout for Stop but gives up on other events", async () => {
        const output = { decision: "block", reason: "[n2n-nexus] new message" };
        fake.respond = () => ({ delayMs: 6_000, raw: JSON.stringify({ output }) });
        const [stop, post] = await Promise.all([
            runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s" })),
            runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s" }))
        ]);
        expect(stop).toMatchObject({ code: 0, stdout: JSON.stringify(output) + "\n" });
        expect(stop.ms).toBeGreaterThanOrEqual(6_000);
        // The other event did not wait for the answer (it would have printed it): its request timed out first.
        expect(post).toMatchObject({ code: 0, stdout: "" });
        expect(post.stderr).toContain("timed out after 5000 ms");
    }, 20_000);

    it("gives a SessionEnd a short budget, within Codex's 3 s SessionEnd limit", async () => {
        fake.respond = () => ({ delayMs: 4_000, raw: JSON.stringify({ output: null }) });
        const result = await runHook(["codex", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "c1" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.ms).toBeLessThan(3_000);
        expect(fake.requests).toHaveLength(1);
    }, 20_000);

    it("stays silent on bad input, a bad client argument and a malformed response", async () => {
        const event = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s" });
        const cases: CliResult[] = [];
        cases.push(await runHook(["claude", "--endpoint", fake.endpoint], "not json"));
        cases.push(await runHook(["claude", "--endpoint", fake.endpoint], "[1,2]"));
        cases.push(await runHook(["cursor", "--endpoint", fake.endpoint], event));
        cases.push(await runHook(["--endpoint", fake.endpoint], event));
        expect(fake.requests).toHaveLength(0);

        for (const raw of ["not json", JSON.stringify({ output: "text" }), JSON.stringify({ nope: 1 }), JSON.stringify({ output: [1] })]) {
            fake.respond = () => ({ raw });
            cases.push(await runHook(["claude", "--endpoint", fake.endpoint], event));
        }
        for (const result of cases) {
            expect(result.code).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr.trim().split("\n")).toHaveLength(1);
        }
    }, 20_000);
});

describe("n2n-nexus hook antigravity, forwarding", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });

    /** Run `hook antigravity <args>` with `stdin`; returns the result and the input it forwarded (undefined: none). */
    async function hook(args: string[], stdin: Record<string, unknown>) {
        fake.requests.length = 0;
        const result = await runHook(["antigravity", ...args, "--endpoint", fake.endpoint], JSON.stringify(stdin));
        const body = fake.requests[0]?.body as { client: string; input: Record<string, unknown> } | undefined;
        expect(fake.requests.length).toBeLessThanOrEqual(1);
        if (body) expect(body.client).toBe("antigravity");
        return { result, input: body?.input };
    }
    const base = { conversationId: "conv-1", cwd: "/home/u", workspacePaths: ["", "/work/a", "/work/b"], transcriptPath: "/t.jsonl", artifactDirectoryPath: "/a", modelName: "m" };

    it("maps SessionStart, its title from lastUserInput, and prints {} for a null output", async () => {
        const { result, input } = await hook(["SessionStart"], { ...base, hookEventName: "SessionStart", lastUserInput: `  ${"x".repeat(MAX_TITLE_CHARS + 5)}\nsecond line` });
        expect(result).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
        expect(input).toEqual({ hook_event_name: "SessionStart", session_id: "conv-1", cwd: "/work/a", title: "x".repeat(MAX_TITLE_CHARS), machine: machineInfo() });
    });

    it("maps PreInvocation by invocationNum and Stop by executionNum, with the registered event argument", async () => {
        // Historical payloads carry no hookEventName: the registered argument names the event.
        expect((await hook(["PreInvocation"], { ...base, invocationNum: 0 })).input).toMatchObject({ hook_event_name: "UserPromptSubmit", session_id: "conv-1" });
        expect((await hook(["PreInvocation"], { ...base, hookEventName: "PreInvocation", invocationNum: 3 })).input).toMatchObject({ hook_event_name: "PostToolUse" });
        expect((await hook(["Stop"], { ...base, hookEventName: "Stop", executionNum: 1, continuationActive: false, fullyIdle: false })).input)
            .toEqual({ hook_event_name: "Stop", session_id: "conv-1", cwd: "/work/a", stop_hook_active: true, machine: machineInfo() });
        expect((await hook(["Stop"], { ...base, executionNum: 0, continuationActive: true })).input).toMatchObject({ stop_hook_active: false });
        // Without an argument, hookEventName names it.
        expect((await hook([], { ...base, hookEventName: "PreInvocation", invocationNum: 0 })).input).toMatchObject({ hook_event_name: "UserPromptSubmit" });
        // cwd: the first workspace path, else cwd, else none.
        expect((await hook(["Stop"], { conversationId: "c", workspacePaths: [], cwd: "/home/u" })).input).toMatchObject({ cwd: "/home/u" });
        expect((await hook(["Stop"], { conversationId: "c" })).input).not.toHaveProperty("cwd");
    });

    it("prints the host's output as one JSON line and skips events the host does not handle", async () => {
        const output = { injectSteps: [{ systemMessage: { systemMessage: "[n2n-nexus] 1 new direct message" } }] };
        fake.respond = () => ({ raw: JSON.stringify({ output }) });
        expect((await hook(["PreInvocation"], { ...base, invocationNum: 0 })).result).toMatchObject({ code: 0, stdout: JSON.stringify(output) + "\n" });
        const skipped = await hook(["PostToolUse"], { ...base, hookEventName: "PostToolUse" });
        expect(skipped.result).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
        expect(skipped.input).toBeUndefined();
    });

    it("waits past the short timeout for Stop only", async () => {
        const output = { decision: "continue", reason: "[n2n-nexus] new message" };
        fake.respond = () => ({ delayMs: 6_000, raw: JSON.stringify({ output }) });
        const [stop, pre] = await Promise.all([
            runHook(["antigravity", "Stop", "--endpoint", fake.endpoint], JSON.stringify({ ...base, executionNum: 0 })),
            runHook(["antigravity", "PreInvocation", "--endpoint", fake.endpoint], JSON.stringify({ ...base, invocationNum: 1 }))
        ]);
        expect(stop).toMatchObject({ code: 0, stdout: JSON.stringify(output) + "\n" });
        expect(pre).toMatchObject({ code: 0, stdout: "" });
        expect(pre.stderr).toContain("timed out after 5000 ms");
    }, 20_000);
});

describe("n2n-nexus hook antigravity --wait", () => {
    let fake: FakeDaemon;
    let dir: string;
    beforeEach(async () => {
        fake = await startFakeDaemon();
        dir = path.join(TMP, "antigravity-wait");
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
    });
    afterEach(async () => { await fake.close(); });
    afterAll(() => cleanupExecutables());

    const SECRET = "csrf-secret-value-123";
    /** A fake agy that records each call's arguments and exits with the next code in ./codes (0 when none is left). */
    function fakeAgy(codes: number[]): { exe: string; calls: () => string[][] } {
        const record = path.join(dir, "agentapi.jsonl");
        const codesFile = path.join(dir, "codes.json");
        fs.writeFileSync(codesFile, JSON.stringify(codes));
        const exe = writeExecutable(path.join(dir, "agy"), `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.ANTIGRAVITY_CSRF_TOKEN }) + "\\n");
const codes = JSON.parse(fs.readFileSync(${JSON.stringify(codesFile)}, "utf8"));
const code = codes.shift() ?? 0;
fs.writeFileSync(${JSON.stringify(codesFile)}, JSON.stringify(codes));
process.exit(code);
`);
        const calls = () => fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; token: string }).map((c) => {
            expect(c.token).toBe(SECRET);                      // agentapi gets the credentials
            return c.args;
        }) : [];
        return { exe, calls };
    }
    const env = (exe: string, extra: NodeJS.ProcessEnv = {}) => ({
        ANTIGRAVITY_CONVERSATION_ID: "conv-9", ANTIGRAVITY_AGENTAPI_EXE: exe, ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1", ANTIGRAVITY_CSRF_TOKEN: SECRET, ...extra
    });
    /** Start the waiter; it never ends by itself, so the test ends it. */
    function startWaiter(environment: NodeJS.ProcessEnv, endpoint = fake.endpoint) {
        const child = spawn(process.execPath, [ENTRY, "hook", "antigravity", "--wait", "--endpoint", endpoint], { env: cliEnv({ NEXUS_ENDPOINT: "", ...environment }), stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
        return { child, stderr: () => stderr, stop: async () => { child.kill("SIGKILL"); await exited; } };
    }
    const events = () => fake.requests.map((r) => (r.body as { input: { hook_event_name: string } }).input.hook_event_name);
    const stamps: number[] = [];

    it("exits 1 without the variables Antigravity gives its commands, naming them and not their values", async () => {
        const result = await runHook(["antigravity", "--wait", "--endpoint", fake.endpoint], "", { ANTIGRAVITY_CONVERSATION_ID: "conv-9", ANTIGRAVITY_CSRF_TOKEN: SECRET });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("ANTIGRAVITY_AGENTAPI_EXE, ANTIGRAVITY_LS_ADDRESS not set");
        expect(result.stderr).not.toContain(SECRET);
        expect(fake.requests).toHaveLength(0);
    });

    it("hands each wake to agentapi send-message once, reports it, and goes on waiting after timeouts", async () => {
        const agy = fakeAgy([0]);
        let waits = 0;
        fake.respond = (body) => {
            const input = body.input as { hook_event_name: string };
            if (input.hook_event_name !== "BackgroundWait") return { raw: JSON.stringify({ output: null }) };
            waits++;
            return { raw: JSON.stringify({ output: waits === 2 ? { wake: "line one\nline \"two\" & more", dispatchId: "d1" } : { timeout: true } }), delayMs: waits > 3 ? 60_000 : 0 };
        };
        const waiter = startWaiter(env(agy.exe));
        expect(await waitFor(() => waits >= 4, 10_000)).toBe(true);
        await waiter.stop();
        expect(agy.calls()).toEqual([["agentapi", "send-message", "conv-9", "line one\nline \"two\" & more"]]);
        expect(events().slice(0, 4)).toEqual(["BackgroundWait", "BackgroundWait", "WakeResult", "BackgroundWait"]);
        expect(fake.requests[2].body).toEqual({ client: "antigravity", input: { hook_event_name: "WakeResult", session_id: "conv-9", dispatch_id: "d1", ok: true } });
        expect(fake.requests[0].body).toEqual({ client: "antigravity", input: { hook_event_name: "BackgroundWait", session_id: "conv-9" } });
        expect(JSON.stringify(fake.requests)).not.toContain(SECRET);       // the credentials never reach the host
        expect(waiter.stderr()).toBe("");
    }, 20_000);

    it("backs off after a null answer, a refusing host and a failed send, doubling the delay", async () => {
        const agy = fakeAgy([1]);
        stamps.length = 0;
        let n = 0;
        fake.respond = (body) => {
            const input = body.input as { hook_event_name: string };
            if (input.hook_event_name !== "BackgroundWait") return { raw: JSON.stringify({ output: null }) };
            stamps.push(Date.now());
            n++;
            if (n === 1) return { raw: JSON.stringify({ output: null }) };                                  // session not known yet
            if (n === 2) return { status: 400, raw: JSON.stringify({ ok: false, error: "Invalid hook request" }) }; // an older host
            if (n === 3) return { raw: JSON.stringify({ output: { wake: "hi", dispatchId: "d2" } }) };
            return { raw: JSON.stringify({ output: { timeout: true } }), delayMs: 60_000 };
        };
        const waiter = startWaiter(env(agy.exe));
        expect(await waitFor(() => n >= 4, 15_000)).toBe(true);
        await waiter.stop();
        const gaps = stamps.slice(1, 4).map((t, i) => t - stamps[i]);
        expect(gaps[0]).toBeGreaterThanOrEqual(WAKE_RETRY_FIRST_DELAY_MS - 50);
        expect(gaps[1]).toBeGreaterThanOrEqual(2 * WAKE_RETRY_FIRST_DELAY_MS - 50);
        // The wake came after the delay was reset by it; its failed send waits the first delay again.
        expect(gaps[2]).toBeGreaterThanOrEqual(WAKE_RETRY_FIRST_DELAY_MS - 50);
        expect(gaps[2]).toBeLessThan(2 * WAKE_RETRY_FIRST_DELAY_MS);
        expect(fake.requests.find((r) => (r.body as { input: { hook_event_name: string } }).input.hook_event_name === "WakeResult")?.body)
            .toEqual({ client: "antigravity", input: { hook_event_name: "WakeResult", session_id: "conv-9", dispatch_id: "d2", ok: false } });
        expect(agy.calls()).toEqual([["agentapi", "send-message", "conv-9", "hi"]]);
        expect(waiter.stderr()).toContain("agentapi send-message failed (exit code 1)");
        expect(waiter.stderr()).not.toContain(SECRET);
    }, 30_000);

    it("reports a wake to the host that sent it, found by discovery, and does not send it again when the report fails", async () => {
        const agy = fakeAgy([0]);
        // The cached host is gone; discovery finds the fake daemon, which sends the wake.
        const home = path.join(dir, "home");
        fs.mkdirSync(path.join(home, ".n2n-nexus"), { recursive: true });
        fs.writeFileSync(path.join(home, ".n2n-nexus", "discovered-endpoint"), `http://127.0.0.1:${await closedPort()}\n`);
        const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
        await new Promise<void>((resolve) => udp.bind(0, () => resolve()));
        const reply = Buffer.from(JSON.stringify({ service: "n2n-nexus", version: "test", host: "0.0.0.0", port: Number(new URL(fake.endpoint).port) }));
        udp.on("message", (msg, rinfo) => { if (msg.toString("utf8") === DISCOVERY_QUERY) udp.send(reply, rinfo.port, rinfo.address); });
        let waits = 0;
        fake.respond = (body) => {
            const input = body.input as { hook_event_name: string };
            if (input.hook_event_name === "WakeResult") return { status: 500, raw: JSON.stringify({ ok: false, error: "boom" }) };
            waits++;
            return { raw: JSON.stringify({ output: waits === 1 ? { wake: "found you", dispatchId: "d3" } : { timeout: true } }), delayMs: waits > 1 ? 60_000 : 0 };
        };
        const waiter = startWaiter(env(agy.exe, { HOME: home, USERPROFILE: home, NEXUS_DISCOVERY_PORT: String(udp.address().port) }), "discover");
        try {
            expect(await waitFor(() => waits >= 2, 15_000)).toBe(true);
        } finally {
            await waiter.stop();
            udp.close();
        }
        expect(events()).toEqual(["BackgroundWait", "WakeResult", "BackgroundWait"]);
        expect(fake.requests[1].body).toEqual({ client: "antigravity", input: { hook_event_name: "WakeResult", session_id: "conv-9", dispatch_id: "d3", ok: true } });
        expect(agy.calls()).toEqual([["agentapi", "send-message", "conv-9", "found you"]]);
    }, 30_000);

    it("finds the executable a .cmd wrapper runs agentapi with", () => {
        const wrapper = path.join(dir, "agentapi.cmd");
        fs.writeFileSync(wrapper, `@echo off\r\n"C:\\Program Files\\Antigravity\\agy.exe" agentapi %*\r\n`);
        expect(agentapiProgram(wrapper)).toBe("C:\\Program Files\\Antigravity\\agy.exe");
        fs.writeFileSync(wrapper, `@echo off\r\n"%~dp0bin\\agy.exe" agentapi %*\r\n`);
        expect(agentapiProgram(wrapper)).toBe(path.join(dir, "bin\\agy.exe"));
        fs.writeFileSync(wrapper, "@echo off\r\nexit 1\r\n");
        expect(agentapiProgram(wrapper)).toBeNull();
        expect(agentapiProgram("/opt/agy/agy")).toBe("/opt/agy/agy");
    });
});

describe("n2n-nexus hook, conversation title", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });

    /** A Claude transcript: `head` records, then filler lines up to `fillerBytes`, then `tail` records. */
    function transcript(name: string, head: object[], tail: object[], fillerBytes = 0): string {
        fs.mkdirSync(TMP, { recursive: true });
        const file = path.join(TMP, `${name}.jsonl`);
        const line = JSON.stringify({ type: "assistant", message: { content: "x".repeat(1000) } }) + "\n";
        const lines = [
            ...head.map((r) => JSON.stringify(r) + "\n"),
            line.repeat(Math.ceil(fillerBytes / line.length)),
            ...tail.map((r) => JSON.stringify(r) + "\n")
        ];
        fs.writeFileSync(file, lines.join(""));
        return file;
    }

    /** Run the hook and return the input it forwarded. */
    async function forwarded(client: string, stdin: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
        fake.requests.length = 0;
        const result = await runHook([client, "--endpoint", fake.endpoint], JSON.stringify(stdin), env);
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(fake.requests).toHaveLength(1);
        return (fake.requests[0].body as { input: Record<string, unknown> }).input;
    }

    it("forwards the last custom title of a Claude transcript before its automatic title", async () => {
        const file = transcript("claude-titles", [], [
            { type: "custom-title", customTitle: "Old name", sessionId: "s" },
            { type: "ai-title", aiTitle: "Auto title", sessionId: "s" },
            { type: "custom-title", customTitle: "  Renamed  ", sessionId: "s" },
            { type: "ai-title", aiTitle: "Later auto title", sessionId: "s" }
        ], 300 * 1024);
        const input = await forwarded("claude", { hook_event_name: "UserPromptSubmit", session_id: "s", transcript_path: file, prompt: "hi" });
        expect(input).toEqual({ hook_event_name: "UserPromptSubmit", session_id: "s", title: "Renamed", machine: machineInfo() });
    });

    it("forwards the automatic title when the transcript has no custom one", async () => {
        const file = transcript("claude-ai-title", [], [{ type: "ai-title", aiTitle: "First", sessionId: "s" }, { type: "ai-title", aiTitle: "Second", sessionId: "s" }]);
        expect((await forwarded("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: file })).title).toBe("Second");
    });

    it("finds a title that is only at the start of a long transcript", async () => {
        const file = transcript("claude-head-title", [{ type: "ai-title", aiTitle: "From the start", sessionId: "s" }], [], 600 * 1024);
        expect((await forwarded("claude", { hook_event_name: "SessionStart", session_id: "s", transcript_path: file })).title).toBe("From the start");
    });

    it("keeps the first line of a title, cut to MAX_TITLE_CHARS characters", async () => {
        const long = transcript("claude-long-title", [], [{ type: "custom-title", customTitle: "界".repeat(100), sessionId: "s" }]);
        expect((await forwarded("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: long })).title).toBe("界".repeat(MAX_TITLE_CHARS));
        const multi = transcript("claude-multiline-title", [], [{ type: "ai-title", aiTitle: "\n  First line \nsecond line", sessionId: "s" }]);
        expect((await forwarded("claude", { hook_event_name: "Stop", session_id: "s", transcript_path: multi })).title).toBe("First line");
    });

    it("forwards no title when the transcript is missing", async () => {
        const input = await forwarded("claude", { hook_event_name: "SessionStart", session_id: "s", transcript_path: path.join(TMP, "no-such.jsonl") });
        expect(input).toEqual({ hook_event_name: "SessionStart", session_id: "s", machine: machineInfo() });
    });

    it("reads no title on PostToolUse", async () => {
        const file = transcript("claude-post-tool", [], [{ type: "custom-title", customTitle: "Named", sessionId: "s" }]);
        const input = await forwarded("claude", { hook_event_name: "PostToolUse", session_id: "s", transcript_path: file, tool_use_id: "t", tool_name: "Bash" });
        expect(input).not.toHaveProperty("title");
    });

    it("forwards a Codex thread's name before its title, from the newest state database", async () => {
        const home = path.join(TMP, "codex-home");
        fs.mkdirSync(home, { recursive: true });
        const { DatabaseSync } = await import("node:sqlite");
        const databases: Array<[string, Array<[string, string, string]>]> = [
            ["state_2.sqlite", [["c1", "stale", "stale"]]],
            ["state_5.sqlite", [["c1", "My thread", "first prompt"], ["c2", "", "What is\nthis?"]]]
        ];
        for (const [file, rows] of databases) {
            const db = new DatabaseSync(path.join(home, file));
            db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL)");
            for (const row of rows) db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(...row);
            db.close();
        }
        const env = { CODEX_HOME: home };
        expect((await forwarded("codex", { hook_event_name: "Stop", session_id: "c1" }, env)).title).toBe("My thread");
        expect((await forwarded("codex", { hook_event_name: "UserPromptSubmit", session_id: "c2" }, env)).title).toBe("What is");
        expect(await forwarded("codex", { hook_event_name: "SessionStart", session_id: "c3" }, env)).not.toHaveProperty("title");
        expect(await forwarded("codex", { hook_event_name: "PostToolUse", session_id: "c1" }, env)).not.toHaveProperty("title");
    });

    it("reads no title for a pi session from Codex's state database, even when a Codex thread has its id", async () => {
        const home = path.join(TMP, "codex-home-pi");
        fs.mkdirSync(home, { recursive: true });
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(path.join(home, "state_1.sqlite"));
        db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL)");
        db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("p1", "A Codex thread", "first prompt");
        db.close();
        const env = { CODEX_HOME: home };
        expect((await forwarded("codex", { hook_event_name: "SessionStart", session_id: "p1" }, env)).title).toBe("A Codex thread");
        for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
            expect(await forwarded("pi", { hook_event_name: event, session_id: "p1" }, env)).not.toHaveProperty("title");
        }
    });

    it("forwards no Codex title without a state database", async () => {
        const home = path.join(TMP, "codex-empty-home");
        fs.mkdirSync(home, { recursive: true });
        expect(await forwarded("codex", { hook_event_name: "SessionStart", session_id: "c1" }, { CODEX_HOME: home })).toEqual({ hook_event_name: "SessionStart", session_id: "c1", machine: machineInfo() });
        expect(await forwarded("codex", { hook_event_name: "Stop", session_id: "c1" }, { CODEX_HOME: path.join(TMP, "no-such-home") })).not.toHaveProperty("title");
    });
});

describe("NexusClient, error status with a non-object body", () => {
    it("rejects with the status instead of crashing the process", async () => {
        const server = await listen((req, res) => {
            req.resume();
            req.on("end", () => { res.writeHead(500, { "Content-Type": "application/json" }); res.end("null"); });
        });
        try {
            const client = new NexusClient({ endpoint: server.endpoint, timeoutMs: 2000 });
            await expect(client.hook({ client: "claude", input: {} })).rejects.toMatchObject({ name: "NexusToolError", message: "HTTP 500", status: 500 });
        } finally {
            await server.close();
        }
    });

    it("rejects a tool call answered 200 with a non-object body as a transport error", async () => {
        const server = await listen((req, res) => {
            req.resume();
            req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("null"); });
        });
        try {
            const client = new NexusClient({ endpoint: server.endpoint, timeoutMs: 2000 });
            await expect(client.callTool("peers", {})).rejects.toBeInstanceOf(NexusTransportError);
        } finally {
            await server.close();
        }
    });
});

describe("waitForWake recovery", () => {
    const endpoint = "http://127.0.0.1:5799";
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it.each(["ECONNREFUSED", "ECONNRESET", REQUEST_TIMEOUT_CODE])("resumes the same wait after %s", async (code) => {
        const hook = vi.spyOn(NexusClient.prototype, "hook")
            .mockRejectedValueOnce(new NexusTransportError("host restarting", code))
            .mockResolvedValueOnce({ output: { wake: "hello after restart", dispatchId: "d1" } });
        const result = expect(waitForWake("codex", "s", endpoint, 600_000)).resolves.toMatchObject({ text: "hello after restart", dispatchId: "d1", endpoint });
        await Promise.all([result, vi.advanceTimersByTimeAsync(1000)]);
        expect(hook).toHaveBeenCalledTimes(2);
    });

    it("ends retries at the original deadline", async () => {
        const hook = vi.spyOn(NexusClient.prototype, "hook").mockRejectedValue(new NexusTransportError("offline", "ECONNREFUSED"));
        const result = expect(waitForWake("codex", "s", endpoint, 2500)).resolves.toBeNull();
        await Promise.all([result, vi.advanceTimersByTimeAsync(2500)]);
        expect(hook).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps session cancellation and invalid replies terminal", async () => {
        const hook = vi.spyOn(NexusClient.prototype, "hook").mockResolvedValueOnce({ output: null });
        await expect(waitForWake("codex", "s", endpoint, 600_000)).resolves.toBeNull();
        for (const error of [new NexusToolError("not allowed", 403), new NexusTransportError("Invalid JSON response")]) {
            hook.mockRejectedValueOnce(error);
            await expect(waitForWake("codex", "s", endpoint, 600_000)).rejects.toBe(error);
        }
        expect(hook).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("n2n-nexus hook --wait", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });
    const waitRequest = (sessionId: string) => ({ url: "/api/hook", body: { client: expect.any(String), input: { hook_event_name: "BackgroundWait", session_id: sessionId } } });

    it("claude: asks again after a timeout, then exits 2 with the notification on stderr", async () => {
        let n = 0;
        fake.respond = () => ({ raw: JSON.stringify({ output: ++n === 1 ? { timeout: true } : { wake: "[n2n-nexus] 1 new direct message", dispatchId: "d1" } }) });
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
        expect(result).toMatchObject({ code: 2, stdout: "" });
        expect(result.stderr).toBe("[n2n-nexus] 1 new direct message\n");
        expect(fake.requests).toEqual([waitRequest("s1"), waitRequest("s1")]);
    });

    it("claude: returns at once in an unattended session (claude -p), which would otherwise wait for it", async () => {
        fake.respond = () => ({ delayMs: 5000, raw: JSON.stringify({ output: { timeout: true } }) });
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), { CLAUDE_CODE_SESSION_ATTENDED: "0" });
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(result.ms).toBeLessThan(3000);
        expect(fake.requests).toHaveLength(0);
    });

    it("claude: exits 0 without output when the session became active", async () => {
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(fake.requests).toHaveLength(1);
    });

    it("exits 0 with one line on stderr when the wait fails: a refusing host, bad input, an unknown client", async () => {
        const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
        fake.respond = () => ({ status: 500, raw: JSON.stringify({ ok: false, error: "boom" }) });
        const refused = [
            await runHook(["claude", "--wait", "--endpoint", fake.endpoint], stop),
            await runHook(["pi", "--wait", "--session", "s1", "--endpoint", fake.endpoint], "")
        ];
        expect(fake.requests).toHaveLength(2);
        for (const result of refused) expect(result).toEqual({ code: 0, stdout: "", stderr: "[n2n-nexus] hook --wait: boom\n", ms: expect.any(Number) });

        const failed = [
            await runHook(["claude", "--wait", "--endpoint", fake.endpoint], "not json"),
            await runHook(["cursor", "--wait", "--endpoint", fake.endpoint], stop)
        ];
        expect(fake.requests).toHaveLength(2);
        for (const result of failed) {
            expect(result).toMatchObject({ code: 0, stdout: "" });
            expect(result.stderr).toMatch(/^\[n2n-nexus\] hook --wait: .+\n$/);
        }
    });

    it("codex: returns at once and leaves a detached wait running for the session", async () => {
        fake.respond = () => ({ delayMs: 500, raw: JSON.stringify({ output: null }) });
        const result = await runHook(["codex", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "c1" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(await waitFor(() => fake.requests.length === 1, 5000)).toBe(true);
        expect(fake.requests[0]).toEqual(waitRequest("c1"));
        // Well within Codex's 10 s hook timeout (HOOK_TIMEOUT_SEC). On Windows the launching PowerShell
        // also looks up the Codex process (Get-CimInstance), which takes seconds on a cold CI runner.
        expect(result.ms).toBeLessThan(8000);
        // Let the detached process receive null and exit before teardown closes its connection.
        expect(await waitFor(() => fake.activeConnections() === 0, 5000)).toBe(true);
    }, 15000);

    it.skipIf(process.platform !== "win32")("codex on Windows: the wait copy does not hold the pipes of the hook Codex runs through PowerShell", async () => {
        // The copy keeps waiting (timeout: true, answered late) while the hook's pipes must already have closed.
        fake.respond = () => ({ delayMs: 8000, raw: JSON.stringify({ output: { timeout: true } }) });
        const command = `& ${[process.execPath, ENTRY, "hook", "codex", "--wait", "--endpoint", fake.endpoint].map((arg) => `'${arg}'`).join(" ")}`;
        const started = Date.now();
        const result = await new Promise<CliResult>((resolve, reject) => {
            const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", command], {
                env: cliEnv({ NEXUS_ENDPOINT: "", CODEX_HOME: path.join(TMP, "no-codex-home") }), stdio: ["pipe", "pipe", "pipe"]
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
            child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "c1" }));
        });
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(result.ms).toBeLessThan(6000);
        expect(await waitFor(() => fake.requests.length === 1, 5000)).toBe(true);
        expect(fake.requests[0]).toEqual(waitRequest("c1"));
        // End the copy: its next request gets null.
        fake.respond = () => ({ raw: JSON.stringify({ output: null }) });
        expect(await waitFor(() => fake.requests.length === 2 && fake.activeConnections() === 0, 15000)).toBe(true);
    }, 30000);

    const wakeResult = (ok: boolean) => ({ url: "/api/hook", body: { client: "codex", input: { hook_event_name: "WakeResult", session_id: "c1", dispatch_id: "d7", ok } } });

    /** The first background wait gets a wake, later ones null (the session became active); WakeResult gets null. */
    const wakeFirst = () => {
        let waits = 0;
        return (body: Record<string, unknown>) => ({
            raw: JSON.stringify({ output: (body.input as { hook_event_name?: string }).hook_event_name === "BackgroundWait" && ++waits === 1 ? { wake: "hello from nexus", dispatchId: "d7" } : null })
        });
    };

    /** Run the Codex wait with ./queue (run by NEXUS_CODEX_COMMAND=node) recording its arguments and exiting with exitCode. */
    async function codexWake(name: string, exitCode: number): Promise<void> {
        const dir = path.join(TMP, name);
        fs.mkdirSync(dir, { recursive: true });
        const record = path.join(dir, "queued.json");
        fs.rmSync(record, { force: true });
        // NEXUS_CODEX_COMMAND=node runs ./queue (the first argument) from the working directory
        // (an ES module: the repository's package.json sets "type": "module").
        fs.writeFileSync(path.join(dir, "queue"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`);
        fake.respond = wakeFirst();
        const result = await runHook(
            ["codex", "--wait", "--session", "c1", "--endpoint", fake.endpoint], "",
            { NEXUS_CODEX_COMMAND: process.execPath }, dir
        );
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["--thread", "c1", "--message", "hello from nexus"]);
    }

    it("codex: hands the notification to codex queue for the session and reports the delivery", async () => {
        await codexWake("codex-queue", 0);
        expect(fake.requests).toEqual([waitRequest("c1"), wakeResult(true)]);
    });

    it("codex: reports a failed codex queue and waits again, so the host can wake the session again", async () => {
        await codexWake("codex-queue-failed", 1);
        expect(fake.requests).toEqual([waitRequest("c1"), wakeResult(false), waitRequest("c1")]);
    });

    it("codex: reports a codex command that cannot be started as failed and waits again", async () => {
        fake.respond = wakeFirst();
        const result = await runHook(
            ["codex", "--wait", "--session", "c1", "--endpoint", fake.endpoint], "",
            { NEXUS_CODEX_COMMAND: path.join(TMP, "no-such-codex") }
        );
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(fake.requests).toEqual([waitRequest("c1"), wakeResult(false), waitRequest("c1")]);
    });
});

describe("n2n-nexus hook --wait, client gone", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });
    /** The id of a process that has exited. */
    const gonePid = () => String(spawnSync(process.execPath, ["-e", ""]).pid);
    /** A process standing in for the client, and a way to end it. */
    const client = () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        return { pid: String(child.pid), kill: () => { child.kill(); } };
    };
    const stop = (sessionId: string) => JSON.stringify({ hook_event_name: "Stop", session_id: sessionId });
    const inputs = () => fake.requests.map((r) => (r.body as { input: unknown }).input);

    it("claude: does not wait once Claude Code (CLAUDE_PID) is gone", async () => {
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], stop("s1"), { CLAUDE_PID: gonePid() });
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(fake.requests).toHaveLength(0);
    });

    it("claude: lets the request in progress end, then asks no more once Claude Code is gone", async () => {
        const claude = client();
        fake.respond = () => { claude.kill(); return { delayMs: 500, raw: JSON.stringify({ output: { timeout: true } }) }; };
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], stop("s1"), { CLAUDE_PID: claude.pid });
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(inputs()).toEqual([{ hook_event_name: "BackgroundWait", session_id: "s1" }]);
    });

    it("claude: reports a wake that arrives after Claude Code is gone as not delivered", async () => {
        const claude = client();
        fake.respond = (body) => {
            if ((body.input as { hook_event_name?: string }).hook_event_name !== "BackgroundWait") return { raw: JSON.stringify({ output: null }) };
            claude.kill();
            return { delayMs: 500, raw: JSON.stringify({ output: { wake: "hello", dispatchId: "d9" } }) };
        };
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], stop("s1"), { CLAUDE_PID: claude.pid });
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(inputs()).toEqual([
            { hook_event_name: "BackgroundWait", session_id: "s1" },
            { hook_event_name: "WakeResult", session_id: "s1", dispatch_id: "d9", ok: false }
        ]);
    });

    it("claude: wakes while Claude Code runs", async () => {
        let n = 0;
        fake.respond = () => ({ raw: JSON.stringify({ output: ++n === 1 ? { timeout: true } : { wake: "still here", dispatchId: "d1" } }) });
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], stop("s1"), { CLAUDE_PID: String(process.pid) });
        expect(result).toMatchObject({ code: 2, stderr: "still here\n" });
        expect(fake.requests).toHaveLength(2);
    });

    it("codex: the detached wait asks no more once the Codex process (--client-pid) is gone", async () => {
        const codex = client();
        fake.respond = () => { codex.kill(); return { delayMs: 500, raw: JSON.stringify({ output: { timeout: true } }) }; };
        const result = await runHook(["codex", "--wait", "--session", "c1", "--client-pid", codex.pid, "--endpoint", fake.endpoint], "");
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(inputs()).toEqual([{ hook_event_name: "BackgroundWait", session_id: "c1" }]);
    });
});

describe("nextQueueRetry", () => {
    it("doubles the delay after each failed codex queue and gives up before it reaches the maximum", () => {
        const delays: number[] = [];
        for (let delay: number | null = WAKE_RETRY_FIRST_DELAY_MS; delay !== null; delay = nextQueueRetry(delay)) delays.push(delay);
        // 1, 2, 4, ... 256 s: ten tries in about 8.5 minutes, then the wait ends.
        expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256].map((s) => s * 1000));
        expect(delays.every((d) => d < WAKE_RETRY_MAX_DELAY_MS)).toBe(true);
    });
});

describe("hookClientPid", () => {
    it.skipIf(process.platform === "win32")("is the parent process when that is not a shell", () => {
        expect(hookClientPid()).toBe(process.ppid);
    });

    it.skipIf(process.platform === "win32")("skips the shell a hook command runs through", () => {
        // "; true" keeps sh from replacing itself with node, as a client's shell does.
        const script = `import { hookClientPid } from ${JSON.stringify(pathToFileURL(path.join(REPO, "build", "cli", "client-process.js")).href)}; console.log(hookClientPid());`;
        const out = spawnSync("sh", ["-c", `"${process.execPath}" --input-type=module -e '${script}'; true`], { encoding: "utf8" });
        expect(out.stdout.trim()).toBe(String(process.pid));
    });
});

describe("n2n-nexus hook --wait, package changed during the wait", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });

    it("codex: still wakes Codex when the installed package loses a module while it waits", async () => {
        // A copy of the package, so a file can disappear from it as an upgrade or a cleared npx cache would do.
        const pkgDir = path.join(TMP, "pkg-copy");
        fs.rmSync(pkgDir, { recursive: true, force: true });
        fs.mkdirSync(pkgDir, { recursive: true });
        for (const name of ["build", "contract", "package.json"]) fs.cpSync(path.join(REPO, name), path.join(pkgDir, name), { recursive: true });
        const dir = path.join(TMP, "codex-queue-changed");
        fs.mkdirSync(dir, { recursive: true });
        const record = path.join(dir, "queued.json");
        fs.rmSync(record, { force: true });
        fs.writeFileSync(path.join(dir, "queue"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
        fake.respond = () => {
            fs.rmSync(path.join(pkgDir, "build", "cli", "client-command.js"), { force: true });   // removed while the wait is held
            return { delayMs: 200, raw: JSON.stringify({ output: { wake: "hello after the change", dispatchId: "d1" } }) };
        };
        const result = await runHook(
            ["codex", "--wait", "--session", "c1", "--endpoint", fake.endpoint], "",
            { NEXUS_CODEX_COMMAND: process.execPath }, dir, path.join(pkgDir, "build", "index.js")
        );
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["--thread", "c1", "--message", "hello after the change"]);
    });
});

describe("runCli, which these tests run the CLI with", () => {
    /** A host that holds every background wait open. */
    async function holdingDaemon(): Promise<FakeDaemon> {
        const fake = await startFakeDaemon();
        fake.respond = () => ({ delayMs: 60_000, raw: JSON.stringify({ output: { timeout: true } }) });
        return fake;
    }
    const wait = (fake: FakeDaemon, timeoutMs?: number) => runCli(["hook", "claude", "--wait", "--endpoint", fake.endpoint],
        { env: cliEnv({ NEXUS_ENDPOINT: "" }), stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), timeoutMs });
    let abandoned: FakeDaemon | undefined;
    afterAll(async () => { await abandoned?.close(); });

    it("ends a CLI that is still running after its time limit, and rejects", async () => {
        const fake = await holdingDaemon();
        try {
            await expect(wait(fake, 1000)).rejects.toThrow("was still running after 1000 ms and was ended");
            expect(await waitFor(() => fake.activeConnections() === 0, 3000)).toBe(true);
        } finally {
            await fake.close();
        }
    });

    it("(first of two) a test ends without waiting for its CLI, as one that timed out does", async () => {
        abandoned = await holdingDaemon();
        void wait(abandoned).catch(() => undefined);
        expect(await waitFor(() => abandoned!.requests.length === 1, 5000)).toBe(true);
    });

    it("(second of two) that CLI was ended when its test was over: a background wait would go on for a day", async () => {
        expect(await waitFor(() => abandoned!.activeConnections() === 0, 3000)).toBe(true);
    });
});

describe("listen, the stand-in servers of these tests", () => {
    it("rejects when the port is taken instead of never settling", async () => {
        const taken = await listen();
        try {
            await expect(listen(undefined, taken.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
        } finally {
            await taken.close();
        }
    });
});

describe("n2n-nexus hook, no daemon", () => {
    it("exits 0 without output when the daemon is unreachable", async () => {
        const port = await closedPort();
        const result = await runHook(["claude", "--endpoint", `http://127.0.0.1:${port}`], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        // It gave up on the refused connection, not on the request's 5 s timeout (the limit leaves room for a slow process start).
        expect(result.stderr).toContain(`No n2n-nexus-host at http://127.0.0.1:${port}`);
        expect(result.ms).toBeLessThan(4_000);
    });

    it("never starts a local daemon: it says on stderr how to start one", async () => {
        const port = await closedPort();
        const result = await runHook(["claude", "--endpoint", `http://127.0.0.1:${port}`], JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.stderr).toContain(`No n2n-nexus-host at http://127.0.0.1:${port}`);
        expect(result.stderr).toContain("Install n2n-nexus-host (https://github.com/n2ns/n2n-nexus/releases)");
        expect(result.stderr).toContain("n2n-nexus-host serve");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(await toolsAnswer(port)).toBe(false);
    }, 15_000);

    // A LAN address of this machine refuses like a remote host would; the hint must not say to start a daemon here.
    const lanAddress = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    it.runIf(lanAddress)("says to start the daemon on that machine when a non-loopback endpoint refuses", async () => {
        const port = await closedPort();
        const endpoint = `http://${lanAddress}:${port}`;
        const result = await runHook(["claude", "--endpoint", endpoint], JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.stderr).toContain(`No n2n-nexus-host at ${endpoint}`);
        expect(result.stderr).toContain("on that machine");
        expect(result.stderr).toContain("n2n-nexus-host serve --host <address>");
        expect(result.stderr).not.toContain("Install n2n-nexus-host");
    }, 15_000);
});

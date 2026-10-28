import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { MAX_TITLE_CHARS } from "../src/contract.js";
import { waitForWake } from "../src/cli/hook.js";
import { machineInfo } from "../src/cli/machine.js";
import { NexusClient, NexusToolError, NexusTransportError, REQUEST_TIMEOUT_CODE } from "../src/client/nexus-client.js";

// Tests the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "hook-cli");

type RunResult = { code: number | null; stdout: string; stderr: string; ms: number };

function runHook(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}, cwd?: string, entry = ENTRY): Promise<RunResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry, "hook", ...args], {
            cwd,
            // CODEX_HOME points at an empty folder unless a test sets it: never read the user's own Codex state.
            env: { ...process.env, NEXUS_ENDPOINT: "", CODEX_HOME: path.join(TMP, "no-codex-home"), ...env },
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
        child.stdin.end(stdin);
    });
}

type FakeDaemon = {
    endpoint: string;
    requests: Array<{ url: string; body: unknown }>;
    activeConnections: () => number;
    respond: (body: Record<string, unknown>) => { delayMs?: number; raw: string };
    close: () => Promise<void>;
};

async function startFakeDaemon(): Promise<FakeDaemon> {
    const fake: Partial<FakeDaemon> = { requests: [], respond: () => ({ raw: JSON.stringify({ output: null }) }) };
    const sockets = new Set<net.Socket>();
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            fake.requests!.push({ url: req.url ?? "", body });
            const reply = fake.respond!(body);
            setTimeout(() => {
                if (res.destroyed) return;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(reply.raw);
            }, reply.delayMs ?? 0);
        });
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    fake.activeConnections = () => sockets.size;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake.close = () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
    return fake as FakeDaemon;
}

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
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

beforeAll(() => {
    execSync("npm run build", { cwd: REPO, stdio: "ignore" });
}, 120_000);

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
        const result = await runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify(stdin));

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(JSON.stringify(output) + "\n");
        expect(fake.requests).toEqual([{
            url: "/api/hook",
            body: { client: "claude", input: { hook_event_name: "PostToolUse", session_id: "s1", cwd: "/work", tool_use_id: "t1", tool_name: "Bash", machine: machineInfo() } }
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
        expect(post).toMatchObject({ code: 0, stdout: "" });
        expect(post.ms).toBeLessThan(6_000);
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
        const cases: RunResult[] = [];
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

    it("forwards no Codex title without a state database", async () => {
        const home = path.join(TMP, "codex-empty-home");
        fs.mkdirSync(home, { recursive: true });
        expect(await forwarded("codex", { hook_event_name: "SessionStart", session_id: "c1" }, { CODEX_HOME: home })).toEqual({ hook_event_name: "SessionStart", session_id: "c1", machine: machineInfo() });
        expect(await forwarded("codex", { hook_event_name: "Stop", session_id: "c1" }, { CODEX_HOME: path.join(TMP, "no-such-home") })).not.toHaveProperty("title");
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

    it("codex: returns at once and leaves a detached wait running for the session", async () => {
        fake.respond = () => ({ delayMs: 500, raw: JSON.stringify({ output: null }) });
        const result = await runHook(["codex", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "c1" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(await waitFor(() => fake.requests.length === 1, 5000)).toBe(true);
        expect(fake.requests[0]).toEqual(waitRequest("c1"));
        expect(result.ms).toBeLessThan(3000);
        // Let the detached process receive null and exit before teardown closes its connection.
        expect(await waitFor(() => fake.activeConnections() === 0, 5000)).toBe(true);
    });

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

describe("n2n-nexus hook, no daemon", () => {
    it("exits 0 without output when the daemon is unreachable", async () => {
        const port = await freePort();
        const result = await runHook(["claude", "--endpoint", `http://127.0.0.1:${port}`], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.ms).toBeLessThan(1_500);
    });

    it("never starts a local daemon: it says on stderr how to start one", async () => {
        const port = await freePort();
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
        const port = await freePort();
        const endpoint = `http://${lanAddress}:${port}`;
        const result = await runHook(["claude", "--endpoint", endpoint], JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.stderr).toContain(`No n2n-nexus-host at ${endpoint}`);
        expect(result.stderr).toContain("on that machine");
        expect(result.stderr).toContain("n2n-nexus-host serve --host <address>");
        expect(result.stderr).not.toContain("Install n2n-nexus-host");
    }, 15_000);
});

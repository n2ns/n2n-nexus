/**
 * Conformance harness: starts the host executable named by NEXUS_HOST_BIN and
 * talks to it only over HTTP, so the same tests accept any host implementation.
 *
 *   <bin> serve --host 127.0.0.1 --port 0 --root <fresh temp dir> [--test-listen-wait-ms <ms>]
 *
 * The bound address is read from the first stderr line matching READY_LINE.
 * One host per test file: `useHost()` starts it in beforeAll and kills it in
 * afterAll. The host is the n2n-nexus-host test build (`go build -tags testclock`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

export const READY_LINE = /listening on http:\/\/(\S+)/;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

const CONTRACT_DIR = fileURLToPath(new URL("../../contract/", import.meta.url));
const readContract = <T>(file: string): T => JSON.parse(readFileSync(path.join(CONTRACT_DIR, file), "utf8")) as T;

export type JsonSchema = Record<string, unknown>;
export type ContractTool = {
    name: string;
    title: string;
    description: string;
    annotations: Record<string, boolean>;
    inputSchema: JsonSchema & { properties: Record<string, JsonSchema>; required?: string[] };
    outputSchema: JsonSchema;
    publishOutputSchema: boolean;
};

export const TOOLS_CONTRACT = readContract<{ contractVersion: number; tools: ContractTool[] }>("tools.json");
export const HOOK = readContract<{
    contractVersion: number;
    clients: string[];
    backgroundWaitEvent: string;
    wakeResultEvent: string;
    agentStatuses: string[];
    timing: Record<"listenWaitMs" | "toolUseBindingTtlMs" | "messageTtlMs" | "idleSubscriptionTtlMs" | "peerWindowMs" | "staleSessionMs" | "wakePromptWindowMs", number>;
    limits: { defaultMaxAutoTurns: number; maxMessageChars: number; maxNoteChars: number; previewChars: number; notifyListLimit: number; notifyTextChars: number; maxHostnameChars: number };
    texts: Record<"noticePrefix" | "notifyClosing" | "stopClosing" | "statusNote" | "sessionStartClosing" | "collaborationRules" | "messageTrustNote" | "messageEnd" | "messageCut" | "replyInstruction" | "readRest" | "replyTool" | "noAgentSessionError", string>;
}>("hook.json");
export const ERRORS = readContract<{ contractVersion: number; maxBodyBytes: number }>("errors.json");

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type HttpResponse<T> = { status: number; headers: http.IncomingHttpHeaders; body: string; payload: T };
export type ToolReply<T> = { ok: boolean; result?: T; error?: string };
export type Caller = { client: "claude"; toolUseId: string } | { client: "codex"; sessionId: string };

/** A request body sent as is instead of JSON-encoded. */
export class RawBody {
    constructor(readonly text: string) { }
}

function toResponse<T>(res: http.IncomingMessage, body: string): HttpResponse<T> {
    let payload: unknown;
    try { payload = body ? JSON.parse(body) : undefined; } catch { payload = undefined; }
    return { status: res.statusCode ?? 0, headers: res.headers, body, payload: payload as T };
}

// ---------------------------------------------------------------------------
// Host process
// ---------------------------------------------------------------------------

/** Per-file host settings, written to the root's settings.json. */
export type HostSettings = {
    /** Tool calls per second per conversation (per instance without the hooks); 0 disables rate limiting. */
    rateLimit?: number;
    rateBurst?: number;
    maxAutoTurns?: number;
    meetingRetentionDays?: number;
    retentionDays?: number;
    /** Host names allowed besides IP literals and the defaults. */
    allowedHosts?: string[];
    /** How long a listening hook is held open (test-only flag). */
    listenWaitMs?: number;
};

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

export class Host {
    port = 0;
    root = "";
    private proc: ChildProcess | null = null;
    private output = "";

    constructor(readonly settings: HostSettings = {}) { }

    /** Whether the host process is running (a test may have stopped it). */
    get running(): boolean {
        return this.proc !== null;
    }

    /** Start the host on a fresh temporary root. */
    async start(): Promise<void> {
        this.root = await fsp.mkdtemp(path.join(os.tmpdir(), "n2n-nexus-conformance-"));
        const { listenWaitMs: _wait, ...file } = this.settings;
        await fsp.writeFile(path.join(this.root, "settings.json"), JSON.stringify(file));
        await this.spawn();
    }

    /** Stop the host (SIGKILL simulates a crash) and start it again on the same root. */
    async restart(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
        await this.stop(signal);
        await this.spawn();
    }

    /** Stop the host process by its PID and wait for it to exit. */
    async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
        const proc = this.proc;
        if (!proc) return;
        this.proc = null;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
        if (signal === "SIGTERM" && process.platform === "win32") {
            // Windows has no SIGTERM to send: the test build stops gracefully on request.
            await this.request("POST", "/test/shutdown").catch(() => { /* exited meanwhile */ });
        } else {
            try { process.kill(proc.pid!, signal); } catch { /* exited meanwhile */ }
        }
        const timer = setTimeout(() => { try { process.kill(proc.pid!, "SIGKILL"); } catch { /* already gone */ } }, STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(timer);
    }

    /** Stop the host and remove its root. */
    async dispose(): Promise<void> {
        await this.stop();
        if (this.root) await fsp.rm(this.root, { recursive: true, force: true });
    }

    private async spawn(): Promise<void> {
        const bin = process.env.NEXUS_HOST_BIN;
        if (!bin) throw new Error("NEXUS_HOST_BIN is not set: point it at the host executable (see tests/conformance/harness.ts)");
        const args = ["serve", "--host", "127.0.0.1", "--port", "0", "--root", this.root];
        if (this.settings.listenWaitMs !== undefined) args.push("--test-listen-wait-ms", String(this.settings.listenWaitMs));

        // The host must not pick up configuration from the developer's environment.
        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("NEXUS_")) env[k] = v;

        const proc = spawn(bin, args, { env, stdio: ["ignore", "ignore", "pipe"] });
        this.proc = proc;
        this.output = "";
        this.port = await new Promise<number>((resolve, reject) => {
            const fail = (why: string) => {
                clearTimeout(timer);
                reject(new Error(`${why}\n--- host stderr ---\n${this.output}`));
            };
            const timer = setTimeout(() => fail(`host did not print its ready line within ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
            proc.stderr!.setEncoding("utf8");
            proc.stderr!.on("data", (chunk: string) => {
                const before = this.output;
                this.output = (this.output + chunk).slice(-64 * 1024);
                if (READY_LINE.test(before)) return;
                const m = this.output.match(READY_LINE);
                if (!m) return;
                clearTimeout(timer);
                resolve(Number(m[1].slice(m[1].lastIndexOf(":") + 1)));
            });
            proc.once("error", (e) => fail(`could not start ${bin}: ${e.message}`));
            proc.once("exit", (code, sig) => fail(`host exited (${code ?? sig}) before it was ready`));
        });
    }

    /** One HTTP request; `body` is JSON-encoded unless it is a RawBody. */
    request<T = unknown>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResponse<T>> {
        return this.openRequest<T>(method, route, body, headers).response;
    }

    /** A request that can be cancelled, as a client does by killing a waiting hook. */
    openRequest<T = unknown>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
        const data = body === undefined ? undefined : body instanceof RawBody ? body.text : JSON.stringify(body);
        let req!: http.ClientRequest;
        const response = new Promise<HttpResponse<T>>((resolve, reject) => {
            req = http.request({
                method, hostname: "127.0.0.1", port: this.port, path: route, agent: false,
                headers: {
                    "Content-Type": "application/json",
                    ...(data !== undefined ? { "Content-Length": String(Buffer.byteLength(data)) } : {}),
                    ...headers
                }
            }, (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c: string) => (raw += c));
                res.on("end", () => resolve(toResponse<T>(res, raw)));
                res.on("error", reject);
            });
            req.on("error", reject);
            req.end(data);
        });
        return { response, cancel: () => req.destroy() };
    }

    /** POST /api/tools/call. `instanceId` null sends none. */
    callTool<T = unknown>(tool: string, args: Record<string, unknown> = {}, instanceId: string | null = "conformance", caller?: Caller) {
        return this.request<ToolReply<T>>("POST", "/api/tools/call", {
            tool, args, ...(instanceId === null ? {} : { instanceId }), ...(caller ? { caller } : {})
        });
    }

    /** Pin the host clock (ms since the epoch) or release it with null. Test build only. */
    async setClock(now: number | null): Promise<void> {
        const res = await this.request("POST", "/test/clock", { now });
        if (res.status !== 200) throw new Error(`POST /test/clock answered ${res.status}: ${res.body} (build the host with -tags testclock)`);
    }

    /** Write a raw HTTP request on a fresh connection and return the raw response. */
    raw(request: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(this.port, "127.0.0.1", () => socket.end(request));
            let out = "";
            socket.setEncoding("utf8");
            socket.on("data", (c: string) => (out += c));
            socket.on("end", () => resolve(out));
            socket.on("error", reject);
        });
    }
}

/** The host for this test file: started in beforeAll, killed and its root removed in afterAll. */
export function useHost(settings: HostSettings = {}): Host {
    const host = new Host(settings);
    beforeAll(() => host.start(), START_TIMEOUT_MS + 5000);
    afterAll(() => host.dispose(), STOP_TIMEOUT_MS + 5000);
    return host;
}

/** Poll `predicate` until it holds. */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();
    while (!(await predicate())) {
        if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
        await new Promise((r) => setTimeout(r, 10));
    }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

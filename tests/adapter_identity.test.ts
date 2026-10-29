import http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { NexusServer } from "../src/server/nexus.js";
import { closedPort, listen } from "./helpers/http.js";

type Recorded = { url: string; body: Record<string, unknown> };
const proxies: NexusServer[] = [];
const clients: Client[] = [];
const servers: http.Server[] = [];

beforeEach(() => {
    process.env.NEXUS_INSTANCE_ID = "identity-test";
});

afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.shutdown()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Daemon stand-in that records every request and echoes tool calls back. */
async function fakeDaemon(port = 0) {
    const requests: Recorded[] = [];
    const { server, endpoint } = await listen((req, res) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => {
            const body = data ? JSON.parse(data) as Record<string, unknown> : {};
            requests.push({ url: req.url!, body });
            if (req.url === "/api/tools") {
                res.end(JSON.stringify({ tools: [{ name: "echo", description: "Echo request", inputSchema: { type: "object", properties: {} } }] }));
            } else {
                res.end(JSON.stringify({ ok: true, result: body }));
            }
        });
    }, port);
    servers.push(server);
    process.env.NEXUS_ENDPOINT = endpoint;
    return requests;
}

async function connect(clientName: string, stateless: boolean) {
    const proxy = new NexusServer();
    proxies.push(proxy);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.run({ transport: serverSide });
    const client = new Client({ name: clientName, version: "1" }, stateless ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    clients.push(client);
    await client.connect(clientSide);
    return client;
}

async function callEcho(client: Client, meta: Record<string, unknown>, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name: "echo", arguments: args, _meta: meta });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Record<string, unknown>;
}

for (const stateless of [false, true]) {
    describe(`Caller identity, ${stateless ? "2026-07-28" : "2025-11-25"} protocol`, () => {
        it("names a Claude Code caller by the toolUseId in _meta, outside model arguments", async () => {
            await fakeDaemon();
            const client = await connect("claude-code", stateless);
            const forwarded = await callEcho(client, { "claudecode/toolUseId": "toolu_1" },
                { caller: { client: "codex", sessionId: "spoofed" } });
            expect(forwarded.caller).toEqual({ client: "claude", toolUseId: "toolu_1" });
            expect(forwarded.args).toEqual({ caller: { client: "codex", sessionId: "spoofed" } });
        });

        it("names a Codex caller by the sessionId in _meta, so each conversation is distinct", async () => {
            await fakeDaemon();
            const client = await connect("codex-mcp-client", stateless);
            expect((await callEcho(client, { sessionId: "thread-a", threadId: "thread-a" })).caller)
                .toEqual({ client: "codex", sessionId: "thread-a" });
            expect((await callEcho(client, { sessionId: "thread-b", threadId: "sub-agent" })).caller)
                .toEqual({ client: "codex", sessionId: "thread-b" });
        });

        it("sends no caller for other clients or when the identifying _meta is missing", async () => {
            await fakeDaemon();
            const other = await connect("Cursor", stateless);
            expect(await callEcho(other, { sessionId: "x", "claudecode/toolUseId": "y" })).not.toHaveProperty("caller");
            const claude = await connect("claude-code", stateless);
            expect(await callEcho(claude, {})).not.toHaveProperty("caller");
        });

        it("registers nothing with the daemon: only the tool list and tool calls are requested", async () => {
            const requests = await fakeDaemon();
            const client = await connect("claude-code", stateless);
            await client.listTools();
            await callEcho(client, { "claudecode/toolUseId": "toolu_2" });
            await client.close();
            expect(new Set(requests.map((r) => r.url))).toEqual(new Set(["/api/tools", "/api/tools/call"]));
        });
    });
}

describe("No daemon", () => {
    const answers = (port: number) => new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/tools`, { timeout: 500 }, (res) => { res.resume(); resolve(true); });
        req.on("error", () => resolve(false));
        req.on("timeout", () => req.destroy());
    });

    it("never starts one: a tool call says how to start it, and the adapter connects once it is up", async () => {
        const port = await closedPort();
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${port}`;
        const proxy = new NexusServer({ retryIntervalMs: 50 });
        proxies.push(proxy);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await proxy.run({ transport: serverSide, input: new PassThrough(), onExit: () => { } });
        const client = new Client({ name: "Cursor", version: "1" });
        clients.push(client);
        await client.connect(clientSide);

        const failed = await client.callTool({ name: "echo", arguments: {} });
        expect(failed.isError).toBe(true);
        const hint = JSON.stringify(failed.content);
        expect(hint).toContain("Install n2n-nexus-host (https://github.com/n2ns/n2n-nexus/releases)");
        expect(hint).toContain("n2n-nexus-host serve");
        await new Promise((resolve) => setTimeout(resolve, 300));     // several retry intervals
        expect(await answers(port)).toBe(false);

        await fakeDaemon(port);
        const deadline = Date.now() + 3000;
        while (!(await client.listTools()).tools.some((t) => t.name === "echo") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await callEcho(client, {});
    });

    it("tells to start a daemon at a non-loopback endpoint on that machine, not this one", async () => {
        process.env.NEXUS_ENDPOINT = "http://192.0.2.1:5688";       // TEST-NET-1: never answers
        const proxy = new NexusServer({ retryIntervalMs: 60_000, requestTimeoutMs: 100 });
        proxies.push(proxy);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await proxy.run({ transport: serverSide, input: new PassThrough(), onExit: () => { } });
        const client = new Client({ name: "Cursor", version: "1" });
        clients.push(client);
        await client.connect(clientSide);

        const failed = await client.callTool({ name: "echo", arguments: {} });
        expect(failed.isError).toBe(true);
        const text = JSON.stringify(failed.content);
        expect(text).toContain("192.0.2.1");
        expect(text).toContain("on that machine");
        expect(text).toContain("n2n-nexus-host serve --host <address>");
        expect(text).not.toContain("Install n2n-nexus-host");
    });

    it("a call the daemon does not answer in time fails alone: the tool list stays and nothing is resent", async () => {
        let calls = 0;
        const { server, endpoint } = await listen((req, res) => {
            req.resume();
            req.on("end", () => {
                if (req.url === "/api/tools") {
                    res.end(JSON.stringify({ tools: [{ name: "echo", description: "Echo request", inputSchema: { type: "object", properties: {} } }] }));
                } else {
                    calls++;
                    setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ ok: true, result: {} })); }, 500);
                }
            });
        });
        servers.push(server);
        process.env.NEXUS_ENDPOINT = endpoint;
        const proxy = new NexusServer({ retryIntervalMs: 50, requestTimeoutMs: 150 });
        proxies.push(proxy);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await proxy.run({ transport: serverSide, input: new PassThrough(), onExit: () => { } });
        const client = new Client({ name: "Cursor", version: "1" });
        clients.push(client);
        await client.connect(clientSide);
        await client.listTools();

        const failed = await client.callTool({ name: "echo", arguments: {} });
        expect(failed.isError).toBe(true);
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
        const text = JSON.stringify(failed.content);
        expect(text).toContain("did not answer in time");
        expect(text).toContain("may still complete");
        expect(text).not.toContain("Reconnecting");
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(calls).toBe(1);
    });

    it("says how to start the daemon when it goes away while connected", async () => {
        await fakeDaemon();
        const client = await connect("Cursor", false);
        await client.listTools();
        const daemon = servers.pop()!;
        daemon.closeAllConnections();
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 50));   // let the client see its pooled socket close
        const failed = await client.callTool({ name: "echo", arguments: {} });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toContain("Install n2n-nexus-host");
    });
});

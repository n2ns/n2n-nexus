import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PassThrough } from "node:stream";

import { NexusServer } from "../src/server/nexus.js";
import { NexusClient, NexusToolError, NexusTransportError } from "../src/client/nexus-client.js";
import { Host } from "./conformance/harness.js";
import { closedPort, listen } from "./helpers/http.js";

/** A real n2n-nexus-host (the test build from tests/setup/go-host.ts) on a fresh temporary root. */
async function startHost(): Promise<Host> {
    const host = new Host();
    await host.start();
    return host;
}

describe("NexusClient error classification", () => {
    let daemon: Host;
    beforeEach(async () => { daemon = await startHost(); });
    afterEach(async () => { await daemon.dispose(); });

    it("reports a failed tool call as NexusToolError", async () => {
        const client = new NexusClient({ endpoint: `http://127.0.0.1:${daemon.port}` });
        await expect(client.callTool("get_task", { taskId: "nope" }, "t")).rejects.toBeInstanceOf(NexusToolError);
        await expect(client.callTool("no_such_tool", {}, "t")).rejects.toMatchObject({ name: "NexusToolError", status: 404 });
    });

    it("reports an unreachable daemon as NexusTransportError", async () => {
        const port = daemon.port;
        await daemon.stop();
        const client = new NexusClient({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 500 });
        await expect(client.fetchTools()).rejects.toBeInstanceOf(NexusTransportError);
        await expect(client.callTool("get_task", { taskId: "x" }, "t")).rejects.toBeInstanceOf(NexusTransportError);
    });
});

// The adapter serves both protocol eras: 2025-era clients open with `initialize`,
// 2026-07-28 clients probe with `server/discover` and send a `_meta` envelope per request.
const ERAS = {
    "2025-11-25 (initialize)": undefined,
    "2026-07-28 (stateless)": { mode: { pin: "2026-07-28" } }
} as const;

describe.each(Object.entries(ERAS))("MCP proxy, %s client", (_era, versionNegotiation) => {
    let daemon: Host;
    const proxies: NexusServer[] = [];
    beforeEach(async () => { daemon = await startHost(); });
    afterEach(async () => {
        await Promise.all(proxies.splice(0).map((proxy) => proxy.shutdown()));
        await daemon.dispose();
    });

    const newClient = (name: string) => new Client({ name, version: "1.0" }, versionNegotiation ? { versionNegotiation } : {});

    async function connectProxy() {
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        process.env.NEXUS_INSTANCE_ID = "proxy-test";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const proxy = new NexusServer();
        proxies.push(proxy);
        await proxy.run({ transport: serverSide });
        const client = newClient("test-ide");
        await client.connect(clientSide);
        return { proxy, client };
    }

    it("keeps the tool list when a tool call fails", async () => {
        const { client } = await connectProxy();
        const before = await client.listTools();
        expect(before.tools.length).toBeGreaterThan(0);
        const del = before.tools.find((t) => t.name === "host_delete_project");
        expect(del?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
        expect(del?.title).toBe("Delete Project");

        const failed = await client.callTool({ name: "get_task", arguments: { taskId: "nope" } });
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed.content)).toContain("not found");

        const after = await client.listTools();
        expect(after.tools.length).toBe(before.tools.length);
        await client.close();
    });

    it("tells the client how to find and message other AI sessions", async () => {
        const { client } = await connectProxy();
        const instructions = client.getInstructions() ?? "";
        for (const tool of ["peers", "send", "read", "reply"]) expect(instructions).toContain(tool);
        await client.close();
    });

    it("answers an unknown tool with a JSON-RPC InvalidParams error", async () => {
        const { client } = await connectProxy();
        await expect(client.callTool({ name: "no_such_tool", arguments: {} }))
            .rejects.toMatchObject({ code: -32602, message: expect.stringContaining("Unknown tool: no_such_tool") });
        // The connection and tool list are unaffected.
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        await client.close();
    });

    it("forwards successful calls and returns the daemon result", async () => {
        const { client } = await connectProxy();
        const result = await client.callTool({ name: "send_message", arguments: { message: "hi" } });
        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(JSON.parse(text)).toMatchObject({ ok: true, sentTo: "global" });
        await client.close();
    });

    it("derives the instance id from the IDE name when none is pinned", async () => {
        delete process.env.NEXUS_INSTANCE_ID;
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const proxy = new NexusServer();
        proxies.push(proxy);
        await proxy.run({ transport: serverSide });
        const client = newClient("Fancy IDE");
        await client.connect(clientSide);
        await client.callTool({ name: "send_message", arguments: { message: "from ide" } });
        const recent = await daemon.callTool<{ messages: { from: string }[] }>("read_messages", { count: 5 }, "observer");
        expect(recent.payload.result?.messages[0].from).toMatch(/^mcp-.+-[0-9a-f]{8}-fancy-ide$/);
        await client.close();
    });
});

describe("MCP proxy lifecycle", () => {
    it("shuts down and exits when its input ends, even while waiting for the daemon", async () => {
        process.env.NEXUS_ENDPOINT = "http://127.0.0.1:1"; // nothing listens here
        process.env.NEXUS_INSTANCE_ID = "lifecycle-test";
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        const input = new PassThrough();
        let exited = false;
        const proxy = new NexusServer();
        await proxy.run({ transport: serverSide, input, onExit: () => { exited = true; } });
        expect((proxy as unknown as { retryTimer: unknown }).retryTimer).not.toBeNull();

        input.resume(); // the stdio transport keeps stdin flowing; mimic that so "end" fires
        input.end();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(exited).toBe(true);
        expect((proxy as unknown as { retryTimer: unknown }).retryTimer).toBeNull();
    });
});

describe("MCP proxy instance id on 2026-07-28 connections", () => {
    let daemon: Host;
    let proxy: NexusServer | undefined;
    beforeEach(async () => { daemon = await startHost(); });
    afterEach(async () => { await proxy?.shutdown(); await daemon.dispose(); });

    it("keeps one instance id when later requests omit clientInfo", async () => {
        delete process.env.NEXUS_INSTANCE_ID;
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        proxy = new NexusServer();
        await proxy.run({ transport: serverSide });

        const responses = new Map<number, unknown>();
        clientSide.onmessage = (m) => { const msg = m as { id?: number }; if (msg.id !== undefined) responses.set(msg.id, msg); };
        await clientSide.start();
        const meta = (withInfo: boolean) => ({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            ...(withInfo ? { "io.modelcontextprotocol/clientInfo": { name: "Fancy IDE", version: "1" } } : {})
        });
        const call = async (id: number, text: string, withInfo: boolean) => {
            await clientSide.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_message", arguments: { message: text }, _meta: meta(withInfo) } });
            for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 10));
        };
        await call(1, "with info", true);
        await call(2, "without info", false);

        const read = await daemon.callTool<{ messages: { from: string }[] }>("read_messages", { count: 5 }, "observer");
        const senders = new Set(read.payload.result?.messages.map((m) => m.from));
        expect(read.payload.result?.messages).toHaveLength(2);
        expect([...senders]).toHaveLength(1);
        expect([...senders][0]).toMatch(/-fancy-ide$/);
        await clientSide.close();
        await proxy.shutdown();
    });
});

describe("MCP proxy with a daemon that accepts connections but never answers", () => {
    it("still answers the client promptly and exits as soon as input ends", async () => {
        const net = await import("node:net");
        const sockets: import("node:net").Socket[] = [];
        const hung = net.createServer((sock) => { sockets.push(sock); });
        await new Promise<void>((r) => hung.listen(0, "127.0.0.1", () => r()));
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${(hung.address() as import("node:net").AddressInfo).port}`;
        process.env.NEXUS_INSTANCE_ID = "hung-test";

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const input = new PassThrough();
        let exitedAt = 0;
        const proxy = new NexusServer();
        const started = Date.now();
        void proxy.run({ transport: serverSide, input, onExit: () => { exitedAt = Date.now(); } });

        const client = new Client({ name: "ide", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        await client.connect(clientSide);
        const list = await client.listTools();
        expect(list.tools).toEqual([]);
        expect(Date.now() - started).toBeLessThan(2500);

        const endAt = Date.now();
        input.resume();
        input.end();
        for (let i = 0; i < 50 && !exitedAt; i++) await new Promise((r) => setTimeout(r, 10));
        expect(exitedAt).toBeGreaterThan(0);
        expect(exitedAt - endAt).toBeLessThan(500);

        sockets.forEach((s) => s.destroy());
        await new Promise((r) => hung.close(r));
    });
});

describe("MCP proxy when the daemon drops a tool", () => {
    it("re-syncs its tool list and notifies the client", async () => {
        const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
        let tools = [tool("old_tool"), tool("kept_tool")];
        const fake = await listen((req, res) => {
            const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
            if (req.url === "/api/tools") return send(200, { tools });
            req.resume();
            req.on("end", () => send(404, { ok: false, error: "Unknown tool: 'old_tool'" }));
        });
        process.env.NEXUS_ENDPOINT = fake.endpoint;
        process.env.NEXUS_INSTANCE_ID = "drop-test";

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const proxy = new NexusServer();
        await proxy.run({ transport: serverSide });
        const client = new Client({ name: "ide", version: "1" });
        let changed = 0;
        client.setNotificationHandler("notifications/tools/list_changed", () => { changed++; });
        await client.connect(clientSide);
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["old_tool", "kept_tool"]);

        tools = [tool("kept_tool")]; // daemon upgraded without the proxy noticing
        await expect(client.callTool({ name: "old_tool", arguments: {} })).rejects.toMatchObject({ code: -32602 });
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["kept_tool"]);
        expect(changed).toBeGreaterThan(0);

        await client.close();
        await proxy.shutdown();
        await fake.close();
    });
});

describe("MCP proxy reconnect loop", () => {
    it("never has more than one daemon request in flight while the daemon hangs", async () => {
        const net = await import("node:net");
        const open = new Set<import("node:net").Socket>();
        let maxConcurrent = 0;
        let total = 0;
        const hung = net.createServer((sock) => {
            sock.resume(); // read the request so the client's FIN is seen and "close" fires
            open.add(sock); total++;
            maxConcurrent = Math.max(maxConcurrent, open.size);
            sock.on("close", () => open.delete(sock));
        });
        await new Promise<void>((r) => hung.listen(0, "127.0.0.1", () => r()));
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${(hung.address() as import("node:net").AddressInfo).port}`;
        process.env.NEXUS_INSTANCE_ID = "retry-test";

        // Attempt (200 ms timeout) outlasts the interval (50 ms): setInterval would stack attempts.
        const proxy = new NexusServer({ retryIntervalMs: 50, requestTimeoutMs: 200 });
        const [, serverSide] = InMemoryTransport.createLinkedPair();
        const input = new PassThrough();
        void proxy.run({ transport: serverSide, input, onExit: () => { } });
        await new Promise((r) => setTimeout(r, 1200));

        expect(total).toBeGreaterThanOrEqual(3);
        expect(maxConcurrent).toBe(1);

        input.resume(); input.end();
        await new Promise((r) => setTimeout(r, 50));
        open.forEach((s) => s.destroy());
        await new Promise((r) => hung.close(r));
    });
});

describe("MCP proxy reconnect race", () => {
    it("keeps reconnecting if the daemon drops again while a successful attempt is still finishing", async () => {
        const http = await import("node:http");
        let drop = true;
        const tools = [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }];
        const fake = http.createServer((req, res) => {
            if (req.url === "/api/tools") { res.end(JSON.stringify({ tools })); return; }
            if (drop) { req.socket.destroy(); return; }
            req.resume();
            req.on("end", () => res.end(JSON.stringify({ ok: true, result: { pong: true } })));
        });
        // Reserve a port, keep it closed so the daemon starts "down".
        const port = await closedPort();
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${port}`;
        process.env.NEXUS_INSTANCE_ID = "race";

        const proxy = new NexusServer({ retryIntervalMs: 50, requestTimeoutMs: 500 });
        const internals = proxy as unknown as { connected: boolean; notifyToolsChanged: () => Promise<void> };
        // Widen the window between "connected" and the end of the attempt (the client notification).
        const notify = internals.notifyToolsChanged.bind(proxy);
        internals.notifyToolsChanged = async () => { if (internals.connected) await new Promise((r) => setTimeout(r, 300)); await notify(); };

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const input = new PassThrough();
        await proxy.run({ transport: serverSide, input, onExit: () => { } });
        const client = new Client({ name: "ide", version: "1" });
        await client.connect(clientSide);

        await new Promise<void>((r) => fake.listen(port, "127.0.0.1", () => r()));
        for (let i = 0; i < 100 && !internals.connected; i++) await new Promise((r) => setTimeout(r, 10));
        const during = await client.callTool({ name: "ping", arguments: {} });   // transport error inside the window
        expect(JSON.stringify(during.content)).toContain("n2n-nexus-host unavailable");

        drop = false;
        await new Promise((r) => setTimeout(r, 1000));
        const after = await client.callTool({ name: "ping", arguments: {} });
        expect(after.isError).toBeFalsy();

        input.resume(); input.end();
        await client.close();
        await proxy.shutdown();
        await new Promise((r) => fake.close(r));
    });
});

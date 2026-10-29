import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { DISCOVER_ENDPOINT, LOCAL_ENDPOINT, discoverEndpoint, resolveEndpoint } from "../src/client/discovery.js";
import { DISCOVERY_QUERY } from "../src/contract.js";
import { NexusServer } from "../src/server/nexus.js";
import { Host } from "./conformance/harness.js";
import { NexusClient } from "../src/client/nexus-client.js";
import { waitForWake } from "../src/cli/hook.js";
import { REPO, runCli } from "./helpers/cli.js";
import { listen } from "./helpers/http.js";

// The hook cases run the built CLI (built by the globalSetup).
const TMP = path.join(REPO, "tests", "tmp", "discovery");
const HOME = path.join(TMP, "home");
const CACHE = path.join(HOME, ".n2n-nexus", "discovered-endpoint");
const ENDPOINT = /^http:\/\/\d+\.\d+\.\d+\.\d+:(\d+)$/;

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NEXUS_DISCOVERY_PORT: process.env.NEXUS_DISCOVERY_PORT, NEXUS_ENDPOINT: process.env.NEXUS_ENDPOINT };
let udpPort = 0;
const sockets: dgram.Socket[] = [];

/** A UDP port that was free a moment ago. */
async function freeUdpPort(): Promise<number> {
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
    const { port } = socket.address();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    return port;
}

/**
 * A stand-in for the discovery responder of n2n-nexus-host bound to `host`: answers
 * DISCOVERY_QUERY on the test's UDP port with the host's reply.
 */
async function responder(httpPort: number, host = "0.0.0.0"): Promise<dgram.Socket> {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const reply = Buffer.from(JSON.stringify({ service: "n2n-nexus", version: "test", host, port: httpPort }));
    socket.on("message", (msg, rinfo) => {
        if (msg.toString("utf8") === DISCOVERY_QUERY) socket.send(reply, rinfo.port, rinfo.address, () => { });
    });
    await new Promise<void>((resolve) => socket.bind(udpPort, () => resolve()));
    sockets.push(socket);
    return socket;
}

const portOf = (endpoint: string | null) => Number(ENDPOINT.exec(endpoint ?? "")?.[1]);

beforeEach(async () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(HOME, { recursive: true });
    udpPort = await freeUdpPort();
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.NEXUS_DISCOVERY_PORT = String(udpPort);
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.close();
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("discoverEndpoint", () => {
    it("finds a responder and builds the endpoint from its address and HTTP port", async () => {
        await responder(4321);
        expect(portOf(await discoverEndpoint(udpPort))).toBe(4321);
    });

    it("uses the bound address of a daemon on this machine that listens on one interface only", async () => {
        await responder(4321, "192.0.2.10");
        expect(await discoverEndpoint(udpPort)).toBe("http://192.0.2.10:4321");
    });

    it("uses loopback for a daemon on this machine that listens on all interfaces", async () => {
        await responder(4321);
        expect(await discoverEndpoint(udpPort)).toBe("http://127.0.0.1:4321");
    });

    it("connects to an IPv6-only host discovered on this machine", async (context) => {
        const server = http.createServer((_req, res) => res.end(JSON.stringify({ tools: [] })));
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen({ host: "::", port: 0, ipv6Only: true }, resolve);
            });
        } catch (error) {
            if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                context.skip("IPv6 is unavailable on this host");
                return;
            }
            throw error;
        }
        try {
            const port = (server.address() as AddressInfo).port;
            await responder(port, "::");
            const endpoint = await discoverEndpoint(udpPort);
            expect(endpoint).toBe(`http://[::1]:${port}`);
            await expect(new NexusClient({ endpoint: endpoint! }).fetchTools()).resolves.toEqual([]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("keeps a remote host's concrete IPv6 address instead of its IPv4 discovery source", async () => {
        await responder(4321, "2001:db8::10");
        const createSocket = dgram.createSocket;
        vi.spyOn(dgram, "createSocket").mockImplementation((...args: Parameters<typeof dgram.createSocket>) => {
            const socket = createSocket(...args);
            socket.on("message", (_msg, source) => { source.address = "192.0.2.20"; });
            return socket;
        });
        expect(await discoverEndpoint(udpPort)).toBe("http://[2001:db8::10]:4321");
    });

    it("ignores a remote IPv6 wildcard that cannot be mapped to a reachable address", async () => {
        await responder(4321, "::");
        const createSocket = dgram.createSocket;
        vi.spyOn(dgram, "createSocket").mockImplementation((...args: Parameters<typeof dgram.createSocket>) => {
            const socket = createSocket(...args);
            socket.on("message", (_msg, source) => { source.address = "192.0.2.20"; });
            return socket;
        });
        expect(await discoverEndpoint(udpPort, 100)).toBeNull();
    });

    it("gives up with null when nothing answers", async () => {
        const before = Date.now();
        expect(await discoverEndpoint(udpPort, 300)).toBeNull();
        expect(Date.now() - before).toBeLessThan(1_000);
    });
});

describe("resolveEndpoint", () => {
    it("rediscovers the endpoint when a background wait loses its cached host", async () => {
        const server = await listen((req, res) => {
            req.resume();
            req.on("end", () => res.end(JSON.stringify({ output: { wake: "after restart", dispatchId: "new-host" } })));
        });
        try {
            const port = server.port;
            await responder(port);
            fs.mkdirSync(path.dirname(CACHE), { recursive: true });
            fs.writeFileSync(CACHE, "http://127.0.0.1:1\n");
            await expect(waitForWake("codex", "s", DISCOVER_ENDPOINT, 5000)).resolves.toEqual({
                text: "after restart", dispatchId: "new-host", endpoint: `http://127.0.0.1:${port}`
            });
            expect(fs.readFileSync(CACHE, "utf8").trim()).toBe(`http://127.0.0.1:${port}`);
        } finally {
            await server.close();
        }
    });

    it("passes any other endpoint through without a lookup", async () => {
        expect(await resolveEndpoint("http://10.0.0.5:5688")).toBe("http://10.0.0.5:5688");
        expect(fs.existsSync(CACHE)).toBe(false);
    });

    it("caches a found daemon and keeps using it until a fresh lookup", async () => {
        const socket = await responder(4321);
        const found = await resolveEndpoint(DISCOVER_ENDPOINT);
        expect(portOf(found)).toBe(4321);
        expect(fs.readFileSync(CACHE, "utf8").trim()).toBe(found);

        socket.close();
        sockets.splice(sockets.indexOf(socket), 1);
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(found);             // cached, no lookup
        expect(await resolveEndpoint(DISCOVER_ENDPOINT, { fresh: true })).toBe(LOCAL_ENDPOINT);
    });

    it("writes the cache next to its file and renames it over, so a concurrent reader never sees a partial URL", async () => {
        await responder(4321);
        const writes = vi.spyOn(fs, "writeFileSync");
        const found = await resolveEndpoint(DISCOVER_ENDPOINT);
        expect(portOf(found)).toBe(4321);
        // Never written in place: a reader sees either no file or the whole URL.
        expect(writes.mock.calls.map((call) => String(call[0]))).not.toContain(CACHE);
        expect(fs.readFileSync(CACHE, "utf8")).toBe(`${found}\n`);
        expect(fs.readdirSync(path.dirname(CACHE))).toEqual(["discovered-endpoint"]);
    });

    it("leaves no temporary file behind when the cache cannot be renamed into place", async () => {
        await responder(4321);
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("EPERM"); });
        const found = await resolveEndpoint(DISCOVER_ENDPOINT);
        expect(portOf(found)).toBe(4321);                                      // the lookup still answers
        expect(fs.readdirSync(path.dirname(CACHE))).toEqual([]);
    });

    it("caches 'none answered' only for a minute", async () => {
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(LOCAL_ENDPOINT);
        await responder(4321);
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(LOCAL_ENDPOINT);    // still within the minute
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
        expect(portOf(await resolveEndpoint(DISCOVER_ENDPOINT))).toBe(4321);
    });
});

describe("hook with --endpoint discover", () => {
    type Fake = { port: number; hits: number; close: () => Promise<void> };
    async function fakeDaemon(): Promise<Fake> {
        const fake = { hits: 0 } as Fake;
        const server = await listen((req, res) => {
            req.resume();
            req.on("end", () => {
                fake.hits++;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" } } }));
            });
        });
        fake.port = server.port;
        fake.close = server.close;
        return fake;
    }

    async function runHook(event = "PostToolUse"): Promise<string> {
        const result = await runCli(["hook", "claude", "--endpoint", DISCOVER_ENDPOINT], {
            env: { ...process.env, NEXUS_ENDPOINT: "" },
            stdin: JSON.stringify({ hook_event_name: event, session_id: "s" })
        });
        return result.stdout;
    }

    it("sends to the discovered daemon, and looks again when the cached one is gone", async () => {
        const fake = await fakeDaemon();
        try {
            await responder(fake.port);
            expect(await runHook()).toContain("hi");
            expect(fake.hits).toBe(1);
            expect(portOf(fs.readFileSync(CACHE, "utf8").trim())).toBe(fake.port);

            fs.writeFileSync(CACHE, "http://127.0.0.2:1\n");                       // a daemon that is gone
            expect(await runHook()).toContain("hi");
            expect(fake.hits).toBe(2);
            expect(portOf(fs.readFileSync(CACHE, "utf8").trim())).toBe(fake.port);
        } finally {
            await fake.close();
        }
    }, 20_000);

    it("does not look again after a SessionEnd times out, so it ends within Codex's 3 s limit", async () => {
        const fake = await fakeDaemon();
        // A cached daemon that accepts the request and never answers.
        const hung = await listen(() => { /* never answers */ });
        try {
            await responder(fake.port);
            fs.mkdirSync(path.dirname(CACHE), { recursive: true });
            const cached = `${hung.endpoint}\n`;

            fs.writeFileSync(CACHE, cached);
            const started = Date.now();
            expect(await runHook("SessionEnd")).toBe("");
            expect(Date.now() - started).toBeLessThan(3000);
            expect(fake.hits).toBe(0);

            fs.writeFileSync(CACHE, cached);                                       // other events still look again
            expect(await runHook()).toContain("hi");
            expect(fake.hits).toBe(1);
        } finally {
            hung.server.closeAllConnections();
            await hung.close();
            await fake.close();
        }
    }, 20_000);
});

describe("MCP adapter with NEXUS_ENDPOINT=discover", () => {
    it("connects to the daemon a lookup finds", async () => {
        const daemon = new Host();
        await daemon.start();
        try {
            await responder(daemon.port);
            process.env.NEXUS_ENDPOINT = DISCOVER_ENDPOINT;
            const adapter = new NexusServer();
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            await adapter.run({ transport: serverSide });
            const client = new Client({ name: "test-ide", version: "1.0" });
            await client.connect(clientSide);
            expect((await client.listTools()).tools.some((t) => t.name === "peers")).toBe(true);

            // A hook found another daemon (the cache changed): the next tool call follows it,
            // so the conversation's hooks and tool calls reach the same daemon.
            let calls = 0;
            const other = await listen((req, res) => {
                req.resume();
                req.on("end", () => {
                    if (req.url === "/api/tools/call") calls++;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(req.url === "/api/tools" ? { tools: [] } : { ok: true, result: { ok: true } }));
                });
            });
            try {
                fs.writeFileSync(CACHE, `${other.endpoint}
`);
                await client.callTool({ name: "send_message", arguments: { message: "hi" } });
                expect(calls).toBe(1);
            } finally {
                await other.close();
            }
            await client.close();
            await adapter.shutdown();
        } finally {
            await daemon.dispose();
        }
    }, 15_000);
});

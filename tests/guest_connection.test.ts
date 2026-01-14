
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createGuestClient } from "../src/network/guest.js";

// Mock Host Implementation
class MockHost {
    server: http.Server;
    mcpServer: Server;
    port: number;
    transports = new Map<string, SSEServerTransport>();

    constructor(port: number) {
        this.port = port;
        this.mcpServer = new Server({ name: "test-host", version: "1.0.0" }, { capabilities: { tools: {} } });

        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: "ping", inputSchema: { type: "object" } }]
        }));

        this.server = http.createServer(async (req, res) => {
            const url = new URL(req.url || "", `http://${req.headers.host}`);
            if (url.pathname === "/mcp") {
                if (req.method === "GET") {
                    const transport = new SSEServerTransport("/mcp", res);
                    this.transports.set(transport.sessionId, transport);
                    await this.mcpServer.connect(transport);
                    return;
                } else if (req.method === "POST") {
                    const sessionId = url.searchParams.get("sessionId");
                    // Quick fix for test: parse from query, or if missing check body (MCP spec varies)
                    // The SSEServerTransport normally handles POST to /message?sessionId=...
                    // But GuestClient posts to /mcp?sessionId=...
                    // Let's ensure the Mock matches GuestClient expectations
                    const transport = sessionId ? this.transports.get(sessionId) : null;
                    if (transport) {
                        await transport.handlePostMessage(req, res);
                    } else {
                        res.writeHead(404).end();
                    }
                    return;
                }
            }
            res.writeHead(404).end();
        });
    }

    start() {
        return new Promise<void>(resolve => this.server.listen(this.port, "127.0.0.1", resolve));
    }

    stop() {
        return new Promise<void>(resolve => this.server.close(() => resolve()));
    }
}

describe("Guest-Host SSE Integration", () => {
    const PORT = 15900;
    let host: MockHost;

    afterEach(async () => {
        if (host) await host.stop();
        // GuestClient has internal timers/connections, but since it's a unit test we let them die with the process or GC
        // In a real scenario we'd want a .close() method on GuestClient.
    });

    it("should successfully connect and exchange messages using real GuestClient", async () => {
        host = new MockHost(PORT);
        await host.start();

        const guest = createGuestClient(PORT, "test-guest");

        // Allow some time for connection (GuestClient connects immediately in constructor)
        await new Promise(r => setTimeout(r, 100));

        // Use sendRequest (public API of the new GuestClient)
        // GuestClient.sendRequest(method, params)
        const response = await guest.sendRequest("tools/list", {});

        // GuestClient returns the RESULT directly (or throws error)
        expect(response).toBeDefined();
        expect(response.tools).toBeDefined();
        expect(response.tools[0].name).toBe("ping");

        guest.close();
    });
});


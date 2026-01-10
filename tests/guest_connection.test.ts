
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
            if (req.params.name === "ping") {
                return { content: [{ type: "text", text: "pong" }] };
            }
            throw new Error("Unknown tool");
        });

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

// Guest Logic Simulating src/index.ts
function runGuest(port: number, messageToSend: any): Promise<string> {
    return new Promise((resolve, reject) => {
        let sessionId: string | null = null;
        let responseBuffer = "";

        const req = http.get(`http://127.0.0.1:${port}/mcp`, (res) => {
            res.on("data", (chunk) => {
                const str = chunk.toString();

                // 1. Handshake: Parse Session ID
                if (!sessionId && str.includes("event: endpoint")) {
                    const match = str.match(/sessionId=([a-f0-9-]+)/);
                    if (match) {
                        sessionId = match[1];

                        // 2. Once connected, Send Request
                        const postReq = http.request({
                            hostname: "127.0.0.1",
                            port: port,
                            path: `/mcp?sessionId=${sessionId}`,
                            method: "POST",
                            headers: { "Content-Type": "application/json" }
                        });
                        postReq.write(JSON.stringify(messageToSend));
                        postReq.end();
                    }
                }

                // 3. Listen for Message
                if (str.includes("event: message")) {
                    const lines = str.split("\n");
                    const dataLine = lines.find((l: string) => l.startsWith("data: "));
                    if (dataLine) {
                        const jsonStr = dataLine.substring(6);
                        responseBuffer += jsonStr;
                        // Determine if complete (naive check for this test)
                        if (jsonStr.includes("jsonrpc")) {
                            req.destroy(); // Close connection
                            resolve(responseBuffer);
                        }
                    }
                }
            });
        });

        req.on("error", reject);

        // Timeout
        setTimeout(() => {
            req.destroy();
            reject(new Error("Timeout waiting for guest response"));
        }, 2000);
    });
}

describe("Guest-Host SSE Integration", () => {
    const PORT = 15900;
    let host: MockHost;

    afterEach(async () => {
        if (host) await host.stop();
    });

    it("should successfully connect and exchange messages using Guest logic", async () => {
        host = new MockHost(PORT);
        await host.start();

        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {}
        };

        const responseStr = await runGuest(PORT, request);
        const response = JSON.parse(responseStr);

        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(1);
        expect(response.result.tools).toBeDefined();
        expect(response.result.tools[0].name).toBe("ping");
    });
});

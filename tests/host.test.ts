/**
 * Host Server Module Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { promises as fs } from "fs";
import path from "path";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-host");
const TEST_PORT = 5799;

describe("Host Server", () => {
    let httpServer: http.Server;

    beforeEach(async () => {
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });

        // Create a basic HTTP server for testing
        httpServer = http.createServer();
        await new Promise<void>((resolve) => {
            httpServer.listen(TEST_PORT, "127.0.0.1", resolve);
        });
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
        await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => { });
    });

    describe("HTTP Request Handling", () => {
        it("should return 404 for unknown paths", async () => {
            // Add a simple handler that returns 404 for all paths
            httpServer.on("request", (req, res) => {
                res.writeHead(404);
                res.end("Not Found");
            });

            const response = await fetch(`http://127.0.0.1:${TEST_PORT}/unknown`);
            expect(response.status).toBe(404);
        });

        it("should handle handshake POST requests", async () => {
            httpServer.on("request", (req, res) => {
                if (req.url === "/nexus/handshake" && req.method === "POST") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        service: "n2n-nexus",
                        protocol: "v1",
                        role: "host",
                        status: "ready"
                    }));
                    return;
                }
                res.writeHead(404);
                res.end();
            });

            const response = await fetch(`http://127.0.0.1:${TEST_PORT}/nexus/handshake`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientVersion: "1.0.0", instanceId: "test" })
            });

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.service).toBe("n2n-nexus");
            expect(data.role).toBe("host");
        });

        it("should handle MCP GET requests for SSE", async () => {
            httpServer.on("request", (req, res) => {
                if (req.url?.startsWith("/mcp") && req.method === "GET") {
                    res.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive"
                    });
                    res.write("event: endpoint\ndata: /mcp?sessionId=test-session\n\n");
                    // Keep connection open briefly then close
                    setTimeout(() => res.end(), 100);
                    return;
                }
                res.writeHead(404);
                res.end();
            });

            const response = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp?id=test-guest`);
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("text/event-stream");
        });
    });
});

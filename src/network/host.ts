/**
 * Host Mode Server
 * 
 * Runs the Nexus server in Host mode, handling SSE connections from Guests.
 */
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AddressInfo } from "net";

import { HEARTBEAT_INTERVAL, SERVICE_NAME } from "../constants.js";
import { StorageManager } from "../storage/index.js";

interface HostContext {
    config: {
        instanceId: string;
        rootStorage: string;
    };
    pkg: { version: string };
    mcpServer: Server;
    sseTransports: Map<string, SSEServerTransport>;
}

/**
 * Start the Host server
 */
export async function startHost(
    httpServer: http.Server,
    context: HostContext
): Promise<void> {
    const { config, pkg, mcpServer, sseTransports } = context;

    await StorageManager.init();

    httpServer.on("request", async (req, res) => {
        const url = new URL(req.url || "", `http://${req.headers.host}`);

        // 1. Handshake endpoint (Discovery)
        if (url.pathname === "/nexus/handshake" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => body += chunk);
            req.on("end", () => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    service: SERVICE_NAME,
                    protocol: "v1",
                    role: "host",
                    serverVersion: pkg.version,
                    rootStorage: config.rootStorage,
                    status: "ready"
                }));
            });
            return;
        }

        // 2. MCP endpoint (SSE)
        if (url.pathname === "/mcp") {
            const guestId = url.searchParams.get("id") || "UnknownGuest";
            if (req.method === "GET") {
                const transport = new SSEServerTransport("/mcp", res);
                sseTransports.set(transport.sessionId, transport);

                const msg = `Guest Joined: ${guestId}`;
                await StorageManager.addGlobalLog(`HOST:${config.instanceId}`, msg, "UPDATE");
                console.error(`[Nexus Hub] ${msg} (Session: ${transport.sessionId})`);

                const heartbeat = setInterval(() => {
                    try { res.write(": ping\n\n"); } catch { clearInterval(heartbeat); }
                }, HEARTBEAT_INTERVAL);

                transport.onclose = () => {
                    sseTransports.delete(transport.sessionId);
                    clearInterval(heartbeat);
                    console.error(`[Nexus Hub] Guest Left: ${guestId}`);
                };
                await mcpServer.connect(transport);
                return;
            } else if (req.method === "POST") {
                const sessionId = url.searchParams.get("sessionId");
                const transport = sessionId ? sseTransports.get(sessionId) : null;
                if (transport) {
                    await transport.handlePostMessage(req, res);
                } else {
                    res.writeHead(404).end("Session unknown");
                }
                return;
            }
        }

        // 3. Other requests: 404
        res.writeHead(404);
        res.end("Not Found");
    });

    // Support local stdio for the host's own IDE
    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);

    const onlineMsg = `Nexus Hub Active. Playing Host.`;
    await StorageManager.addGlobalLog(`SYSTEM:${config.instanceId}`, onlineMsg, "UPDATE");
    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' ? (addr as AddressInfo).port : '?';
    console.error(`[Nexus:${config.instanceId}] ${onlineMsg} (Port: ${port})`);
}

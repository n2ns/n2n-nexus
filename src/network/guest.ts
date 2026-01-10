/**
 * Guest Mode Client
 * 
 * Connects to a Host server via SSE and proxies stdio.
 */
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { NEXUS_HOST } from "../constants.js";
import { isHostAutoElection } from "./election.js";
import { startHost } from "./host.js";

interface GuestContext {
    config: {
        instanceId: string;
        isHost: boolean;
        rootStorage: string;
        port: number;
    };
    pkg: { version: string };
    mcpServer: Server;
    sseTransports: Map<string, unknown>;
}

/**
 * Start Guest mode - connect to Host and proxy stdio
 */
export async function startGuest(
    targetPort: number,
    context: GuestContext
): Promise<void> {
    const { config, mcpServer, sseTransports } = context;
    const guestId = config.instanceId;

    const reconnect = async () => {
        console.error("[Nexus Guest] Lost connection to Host. Attempting to become new Host...");

        const result = await isHostAutoElection(config.rootStorage);

        if (result.isHost && result.server) {
            // Bind success → I become Host
            console.error(`[Nexus] Promoted to Host on port ${result.port}!`);
            config.isHost = true;
            config.port = result.port;
            await startHost(result.server, {
                config,
                pkg: context.pkg,
                mcpServer,
                sseTransports: sseTransports as Map<string, never>
            });
        } else {
            // Bind failed → Another Guest became Host → Connect to it
            console.error(`[Nexus] Found new Host at ${result.port}. Reconnecting...`);
            config.port = result.port;
            startGuest(result.port, context);
        }
    };

    const connect = () => {
        process.stdin.removeAllListeners("data");

        console.error(`[Nexus:${guestId}] Connecting to Host at ${targetPort}...`);

        let sessionId: string | null = null;
        let pendingStdin: Buffer[] = [];
        let sseBuffer = "";

        // Client connection should use 127.0.0.1 if host is 0.0.0.0
        const connectHost = NEXUS_HOST === "0.0.0.0" ? "127.0.0.1" : NEXUS_HOST;

        const forwardToHost = (chunk: Buffer) => {
            if (!sessionId) {
                pendingStdin.push(chunk);
                return;
            }
            try {
                const req = http.request({
                    hostname: connectHost,
                    port: targetPort,
                    path: `/mcp?sessionId=${sessionId}&id=${encodeURIComponent(guestId)}`,
                    method: "POST",
                    headers: { "Content-Type": "application/json" }
                });
                req.on("error", () => { /* suppress */ });
                req.write(chunk);
                req.end();
            } catch { /* suppress */ }
        };

        const stdioHandler = (chunk: Buffer) => forwardToHost(chunk);
        process.stdin.on("data", stdioHandler);

        http.get(`http://${connectHost}:${targetPort}/mcp?id=${encodeURIComponent(guestId)}`, (res) => {
            res.on("data", (chunk) => {
                sseBuffer += chunk.toString();
                const lines = sseBuffer.split("\n");
                sseBuffer = lines.pop() || ""; // Keep trailing incomplete line

                for (const line of lines) {
                    const cleanLine = line.trim();
                    if (!cleanLine) continue;

                    if (cleanLine.startsWith("data: ")) {
                        const content = cleanLine.substring(6);

                        // Check if this is the endpoint/session assignment
                        if (!sessionId && content.includes("sessionId=")) {
                            const match = content.match(/sessionId=([a-f0-9-]+)/);
                            if (match) {
                                sessionId = match[1];
                                // console.error(`[Nexus:${guestId}] Session established: ${sessionId}`);
                                // Flush pending messages
                                const toFlush = [...pendingStdin];
                                pendingStdin = [];
                                toFlush.forEach(forwardToHost);
                            }
                        } else if (content) {
                            // Assume JSON-RPC message
                            try {
                                process.stdout.write(content + "\n");
                            } catch { /* ignore */ }
                        }
                    }
                }
            });
            res.on("end", () => {
                process.stdin.removeAllListeners("data");
                reconnect();
            });
        }).on("error", () => {
            process.stdin.removeAllListeners("data");
            reconnect();
        });
    };
    connect();
}

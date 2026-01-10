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

        const stdioHandler = (chunk: Buffer) => {
            if (!sessionId) return;
            try {
                const req = http.request({
                    hostname: NEXUS_HOST,
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
        process.stdin.on("data", stdioHandler);

        http.get(`http://${NEXUS_HOST}:${targetPort}/mcp?id=${encodeURIComponent(guestId)}`, (res) => {
            let buffer = "";
            res.on("data", (chunk) => {
                const str = chunk.toString();
                buffer += str;
                if (!sessionId && buffer.includes("event: endpoint")) {
                    const match = buffer.match(/sessionId=([a-f0-9-]+)/);
                    if (match) sessionId = match[1];
                }
                if (str.includes("event: message")) {
                    const lines = str.split("\n");
                    const dataLine = lines.find((l: string) => l.startsWith("data: "));
                    if (dataLine) {
                        try { process.stdout.write(dataLine.substring(6) + "\n"); } catch { /* ignore */ }
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

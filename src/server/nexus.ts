import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { NexusClient, ToolDefinition } from "../client/nexus-client.js";
import { pkg } from "../config/index.js";

const RETRY_INTERVAL_MS = 3000;
const SERVICE_NAME = "n2n-nexus";

export class NexusServer {
    private server: Server;
    private client: NexusClient;
    private instanceId: string;
    private cachedTools: ToolDefinition[] = [];
    private retryTimer: NodeJS.Timeout | null = null;
    private connected = false;

    constructor() {
        const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        const instanceId = process.env.NEXUS_INSTANCE_ID ||
            process.argv.find((_, i) => process.argv[i - 1] === "--id") ||
            `mcp-${Math.random().toString(36).slice(2, 6)}`;

        this.instanceId = instanceId;
        this.client = new NexusClient({ endpoint, timeoutMs: 5000 });

        this.server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { tools: { listChanged: true } } }
        );

        this.setupHandlers();
    }

    private setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.cachedTools
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (!this.connected) {
                return {
                    content: [{ type: "text", text: "Daemon is not ready yet. Please wait a moment and retry." }],
                    isError: true
                };
            }

            try {
                const result = await this.client.callTool(
                    request.params.name,
                    request.params.arguments,
                    this.instanceId
                );
                return {
                    content: [{
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
                    }]
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                // Daemon went away — start retry loop
                if (this.connected) {
                    this.connected = false;
                    this.cachedTools = [];
                    await this.server.sendToolListChanged();
                    this.scheduleRetry();
                }
                return {
                    content: [{ type: "text", text: `Daemon unavailable: ${message}. Reconnecting...` }],
                    isError: true
                };
            }
        });
    }

    private async tryConnect(): Promise<boolean> {
        try {
            const tools = await this.client.fetchTools();
            this.cachedTools = tools;
            this.connected = true;
            console.error(`[n2n-nexus] Connected to daemon. ${tools.length} tools loaded.`);
            await this.server.sendToolListChanged();
            return true;
        } catch {
            return false;
        }
    }

    private scheduleRetry() {
        if (this.retryTimer) return;
        const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
        this.retryTimer = setInterval(async () => {
            console.error(`[n2n-nexus] Waiting for daemon at ${endpoint}...`);
            const ok = await this.tryConnect();
            if (ok && this.retryTimer) {
                clearInterval(this.retryTimer);
                this.retryTimer = null;
            }
        }, RETRY_INTERVAL_MS);
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        // Try to connect immediately; if not ready, start retry loop
        const ok = await this.tryConnect();
        if (!ok) {
            const endpoint = process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
            console.error(`[n2n-nexus] Daemon not available at ${endpoint}. Will retry every ${RETRY_INTERVAL_MS / 1000}s...`);
            this.scheduleRetry();
        }
    }
}

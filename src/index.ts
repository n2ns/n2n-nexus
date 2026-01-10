#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ErrorCode,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import http from "http";

import { CONFIG, hostServer } from "./config.js";
import { StorageManager } from "./storage/index.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools/index.js";
import { listResources, getResourceContent } from "./resources/index.js";
import { sanitizeErrorMessage } from "./utils/error.js";
import { checkHostPermission } from "./utils/auth.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 * 
 * Modular MCP Server for multi-AI assistant coordination.
 */
class NexusServer {
    private server: Server;
    private currentProject: string | null = null;
    private sseTransports = new Map<string, SSEServerTransport>();

    constructor() {
        this.server = new Server(
            { name: "n2n-nexus", version: pkg.version },
            { capabilities: { resources: {}, tools: {}, prompts: {} } }
        );
        this.setupHandlers();
    }

    private setupHandlers() {
        // --- Resource Listing ---
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            try {
                return await listResources();
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Registry Error: ${sanitizeErrorMessage(msg)}`);
            }
        });

        // --- Resource Reading ---
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const { uri } = request.params;
            try {
                await StorageManager.init();
                const content = await getResourceContent(uri, this.currentProject);
                if (content) {
                    return { contents: [{ uri, mimeType: content.mimeType, text: content.text }] };
                }
                throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
            } catch (error: unknown) {
                if (error instanceof McpError) throw error;
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Resource Error: ${sanitizeErrorMessage(msg)}`);
            }
        });

        // --- Tool Listing ---
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: TOOL_DEFINITIONS
        }));

        // --- Tool Execution ---
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: toolArgs } = request.params;

            try {
                if (name.startsWith("host_")) checkHostPermission(name);

                const result = await handleToolCall(
                    name,
                    toolArgs as Record<string, unknown>,
                    {
                        currentProject: this.currentProject,
                        setCurrentProject: (id: string) => { this.currentProject = id; },
                        notifyResourceUpdate: (uri: string) => {
                            this.server.sendResourceUpdated({ uri });
                        }
                    }
                );
                return result;
            } catch (error: unknown) {
                if (error instanceof McpError) throw error;
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{ type: "text", text: `Nexus Error: ${sanitizeErrorMessage(errorMessage)}` }]
                };
            }
        });

        // --- Prompt Listing ---
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
            prompts: [
                {
                    name: "init_project_nexus",
                    description: "Step-by-step guide for registering a new project with proper ID naming conventions.",
                    arguments: [
                        { name: "projectType", description: "Type: web, api, chrome, vscode, mcp, android, ios, flutter, desktop, lib, bot, infra, doc", required: true },
                        { name: "technicalName", description: "Domain (e.g., example.com) or repo slug (e.g., my-library)", required: true }
                    ]
                }
            ]
        }));

        // --- Prompt Retrieval ---
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            if (name === "init_project_nexus") {
                const projectType = args?.projectType || "[TYPE]";
                const technicalName = args?.technicalName || "[NAME]";
                const projectId = `${projectType}_${technicalName}`;

                return {
                    description: "Initialize a new Nexus project",
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `I want to register a new project in Nexus.\n\n**Project Type:** ${projectType}\n**Technical Name:** ${technicalName}`
                            }
                        },
                        {
                            role: "assistant",
                            content: {
                                type: "text",
                                text: `## Project ID Convention\n\nBased on your input, the correct Project ID is:\n\n\`\`\`\n${projectId}\n\`\`\`\n\n### Prefix Dictionary\n| Prefix | Use Case |\n|--------|----------|\n| web_ | Websites/Domains |\n| api_ | Backend Services |\n| chrome_ | Chrome Extensions |\n| vscode_ | VSCode Extensions |\n| mcp_ | MCP Servers |\n| android_ | Native Android |\n| ios_ | Native iOS |\n| flutter_ | Cross-platform Mobile |\n| desktop_ | Desktop Apps |\n| lib_ | Libraries/SDKs |\n| bot_ | Bots |\n| infra_ | Infrastructure as Code |\n| doc_ | Technical Docs |\n\n### Next Steps\n1. Call \`register_session_context\` with projectId: \`${projectId}\`\n2. Call \`sync_project_assets\` with your manifest and internal docs.`
                            }
                        }
                    ]
                };
            }

            throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
        });
    }

    async run() {
        // Handle graceful shutdown
        const shutdown = async (signal: string) => {
            console.error(`\n[Nexus] Received ${signal}. Shutting down...`);
            try {
                const msg = `Nexus Session Terminated (IDE Closed).`;
                await StorageManager.addGlobalLog(`SYSTEM:${CONFIG.instanceId}`, msg, "UPDATE");
                console.error(`[Nexus:${CONFIG.instanceId}] Goodbye!`);
            } catch { /* ignore */ }
            process.exit(0);
        };

        // Global Error Handlers to prevent process exit on background errors
        process.on("uncaughtException", (err) => {
            console.error("[Nexus CRITICAL] Uncaught Exception:", err);
            // Attempt to log to disk if possible, but keep process alive if safe
            // For a Hub, staying alive is often preferred over crashing
        });

        process.on("unhandledRejection", (reason, promise) => {
            console.error("[Nexus WARNING] Unhandled Rejection at:", promise, "reason:", reason);
            // Do not exit. Background tasks (like file sync) often trigger this.
        });

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));

        if (CONFIG.isHost && hostServer) {
            // --- HOST MODE: Central Hub ---
            await StorageManager.init();

            hostServer.on("request", async (req, res) => {
                const url = new URL(req.url || "", `http://${req.headers.host}`);

                if (url.pathname === "/mcp") {
                    const guestId = url.searchParams.get("id") || "UnknownGuest";
                    if (req.method === "GET") {
                        const transport = new SSEServerTransport("/mcp", res);
                        this.sseTransports.set(transport.sessionId, transport);

                        const msg = `Guest Joined: ${guestId}`;
                        await StorageManager.addGlobalLog(`HOST:${CONFIG.instanceId}`, msg, "UPDATE");
                        console.error(`[Nexus Hub] ${msg} (Session: ${transport.sessionId})`);

                        // Heartbeat: keep connection alive
                        const heartbeat = setInterval(() => {
                            try { res.write(": ping\n\n"); } catch { clearInterval(heartbeat); }
                        }, 30000);

                        transport.onclose = () => {
                            this.sseTransports.delete(transport.sessionId);
                            clearInterval(heartbeat);
                            console.error(`[Nexus Hub] Guest Left: ${guestId}`);
                        };
                        await this.server.connect(transport);
                        return;
                    } else if (req.method === "POST") {
                        const sessionId = url.searchParams.get("sessionId");
                        const transport = sessionId ? this.sseTransports.get(sessionId) : null;
                        if (transport) {
                            await transport.handlePostMessage(req, res);
                        } else {
                            res.writeHead(404).end("Session unknown");
                        }
                        return;
                    }
                }
            });

            // Support local stdio for the host's own IDE
            const transport = new StdioServerTransport();
            await this.server.connect(transport);

            const onlineMsg = `Nexus Hub Active. Playing Host.`;
            await StorageManager.addGlobalLog(`SYSTEM:${CONFIG.instanceId}`, onlineMsg, "UPDATE");
            console.error(`[Nexus:${CONFIG.instanceId}] ${onlineMsg} (Port: ${CONFIG.port})`);
        } else {
            // --- GUEST MODE: SSE Proxy ---
            const guestId = CONFIG.instanceId;
            let retryCount = 0;
            const maxRetries = 50; // Prevent infinite reconnection loops

            // Random delay function to prevent thundering herd during re-election
            const randomDelay = () => Math.floor(Math.random() * 3000);

            const startProxy = () => {
                if (retryCount >= maxRetries) {
                    console.error(`[Nexus Guest] Max retries (${maxRetries}) reached. Exiting.`);
                    process.exit(1);
                }
                retryCount++;

                // Clear any stale stdin listeners before starting
                process.stdin.removeAllListeners("data");

                console.error(`[Nexus:${guestId}] Global Hub detected at ${CONFIG.port}. Joining... (attempt ${retryCount})`);
                let sessionId: string | null = null;
                let lastActivity = Date.now();

                // Watchdog: trigger re-election if Host is silent for too long
                const watchdog = setInterval(() => {
                    if (Date.now() - lastActivity > 60000) {
                        console.error("[Nexus Guest] Host stale. Reconnecting...");
                        cleanup();
                        // Use setImmediate to break call stack, then delay
                        setImmediate(() => setTimeout(startProxy, randomDelay()));
                    }
                }, 10000);

                const cleanup = () => {
                    clearInterval(watchdog);
                    process.stdin.removeAllListeners("data");
                };

                const stdioHandler = (chunk: Buffer) => {
                    if (!sessionId) return;
                    try {
                        const req = http.request({
                            hostname: "127.0.0.1",
                            port: CONFIG.port,
                            path: `/mcp?sessionId=${sessionId}&id=${encodeURIComponent(guestId)}`,
                            method: "POST",
                            headers: { "Content-Type": "application/json" }
                        });
                        // Handle request errors to prevent unhandled exceptions
                        req.on("error", () => { /* suppress ECONNREFUSED etc. */ });
                        req.write(chunk);
                        req.end();
                    } catch { /* suppress */ }
                };
                process.stdin.on("data", stdioHandler);

                http.get(`http://127.0.0.1:${CONFIG.port}/mcp?id=${encodeURIComponent(guestId)}`, (res) => {
                    retryCount = 0; // Reset on successful connection
                    let buffer = "";
                    res.on("data", (chunk) => {
                        lastActivity = Date.now();
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
                                try { process.stdout.write(dataLine.substring(6) + "\n"); } catch { /* ignore stdout errors */ }
                            }
                        }
                    });
                    res.on("end", () => {
                        console.error("[Nexus Guest] Lost connection to Host. Reconnecting...");
                        cleanup();
                        // Use setImmediate to break call stack
                        setImmediate(() => setTimeout(startProxy, randomDelay()));
                    });
                }).on("error", () => {
                    console.error("[Nexus Guest] Proxy Receive Error. Retrying...");
                    cleanup();
                    setImmediate(() => setTimeout(startProxy, 1000 + randomDelay()));
                });
            };
            startProxy();
        }
    }
}

const server = new NexusServer();
server.run().catch(console.error);

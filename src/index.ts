#!/usr/bin/env node
/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 * 
 * Modular MCP Server for multi-AI assistant coordination.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

import { CONFIG, hostServer, pkg, updateConfig, setHostServer, isHostAutoElection } from "./config/index.js";
import { StorageManager } from "./storage/index.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools/index.js";
import { listResources, getResourceContent } from "./resources/index.js";
import { sanitizeErrorMessage } from "./utils/error.js";
import { checkHostPermission } from "./utils/auth.js";
import { SERVICE_NAME } from "./constants.js";
import { startHost, startGuest } from "./network/index.js";

class NexusServer {
    private server: Server;
    private currentProject: string | null = null;
    private sseTransports = new Map<string, SSEServerTransport>();

    constructor() {
        this.server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
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
            try {
                const result = await getResourceContent(request.params.uri, this.currentProject);
                if (!result) {
                    throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${request.params.uri}`);
                }
                return { contents: [{ uri: request.params.uri, ...result }] };
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Read Error: ${sanitizeErrorMessage(msg)}`);
            }
        });

        // --- Tool Listing ---
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: TOOL_DEFINITIONS };
        });

        // --- Tool Calling ---
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const agentId = CONFIG.instanceId;
            try {
                // Special handling for switch_project
                if (request.params.name === "switch_project") {
                    const args = request.params.arguments as { project_id?: string };
                    if (args.project_id) {
                        const manifest = await StorageManager.getProjectManifest(args.project_id);
                        if (manifest) {
                            this.currentProject = args.project_id;
                            return { content: [{ type: "text", text: `Switched to project: ${args.project_id}` }] };
                        }
                    }
                    return { content: [{ type: "text", text: `Project '${args.project_id}' not found.` }] };
                }

                // Host permission check for privileged tools
                const hostOnlyTools = ["delete_project", "rename_project", "clear_global_logs", "archive_meeting"];
                if (hostOnlyTools.includes(request.params.name)) {
                    try {
                        checkHostPermission(request.params.name);
                    } catch {
                        return { content: [{ type: "text", text: `[Permission Denied] Tool '${request.params.name}' requires Host privileges.` }] };
                    }
                }

                // Delegate to tool handler
                const ctx = {
                    currentProject: this.currentProject,
                    setCurrentProject: (id: string) => { this.currentProject = id; },
                    notifyResourceUpdate: (_uri: string) => { /* MCP notification would go here */ }
                };
                const result = await handleToolCall(
                    request.params.name,
                    request.params.arguments as Record<string, unknown>,
                    ctx
                );
                return result;
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: sanitizeErrorMessage(`Tool Error: ${msg}`) }],
                    isError: true
                };
            }
        });

        // --- Prompt Listing ---
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return {
                prompts: [
                    {
                        name: "nexus_status",
                        description: "Get a comprehensive status report of the current Nexus Hub state"
                    }
                ]
            };
        });

        // --- Prompt Getting ---
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            if (request.params.name === "nexus_status") {
                const registry = await StorageManager.listRegistry();
                const projectCount = Object.keys(registry.projects).length;
                const logs = await StorageManager.getRecentLogs(5);

                return {
                    messages: [{
                        role: "user",
                        content: {
                            type: "text",
                            text: `Nexus Hub Status:
- Role: ${CONFIG.isHost ? "Host" : "Guest"}
- Instance: ${CONFIG.instanceId}
- Port: ${CONFIG.port}
- Active Projects: ${projectCount}
- Recent Activity: ${logs.length} entries`
                        }
                    }]
                };
            }
            throw new McpError(ErrorCode.InvalidRequest, `Prompt not found: ${request.params.name}`);
        });
    }

    private setupShutdownHandlers() {
        const shutdown = async (signal: string) => {
            console.error(`\n[Nexus] Received ${signal}. Shutting down...`);
            try {
                const msg = `Nexus Session Terminated (IDE Closed).`;
                await StorageManager.addGlobalLog(`SYSTEM:${CONFIG.instanceId}`, msg, "UPDATE");
                console.error(`[Nexus:${CONFIG.instanceId}] Goodbye!`);
            } catch { /* ignore */ }
            process.exit(0);
        };

        process.on("uncaughtException", (err) => {
            console.error("[Nexus CRITICAL] Uncaught Exception:", err);
        });

        process.on("unhandledRejection", (reason, promise) => {
            console.error("[Nexus WARNING] Unhandled Rejection at:", promise, "reason:", reason);
        });

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));
    }

    async run() {
        this.setupShutdownHandlers();

        const context = {
            config: CONFIG,
            pkg,
            mcpServer: this.server,
            sseTransports: this.sseTransports
        };

        // 1. Start Election in Background
        console.error(`[Nexus] Starting in Online First mode...`);

        // Asynchronously determine role
        isHostAutoElection(CONFIG.rootStorage).then(async (election) => {
            console.error(`[Nexus] Election finished. Role: ${election.isHost ? "HOST" : "GUEST"}`);

            // Update Global Config
            updateConfig({
                isHost: election.isHost,
                port: election.port,
                rootStorage: election.isHost ? CONFIG.rootStorage : (election.rootStorage || CONFIG.rootStorage)
            });

            if (election.server) {
                setHostServer(election.server);
            }

            // Start appropriate network service
            if (election.isHost && election.server) {
                await startHost(election.server, context);
            } else {
                // Critical: Close the initial Stdio transport before handing over to Guest proxy
                // This prevents race conditions where both instances attempt to read stdin
                await this.server.close();
                console.error(`[Nexus] Local Server closed. Transitioning to Guest Proxy...`);

                await startGuest(election.port, context);
            }
        }).catch(err => {
            console.error(`[Nexus CRITICAL] Election failed:`, err);
        });

        // 2. Connect via Stdio IMMEDIATELY (Don't wait for election)
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`[Nexus] MCP Server connected via stdio.`);
    }
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new NexusServer();
server.run().catch(console.error);

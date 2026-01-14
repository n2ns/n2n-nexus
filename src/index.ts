#!/usr/bin/env node
/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 * 
 * Modular MCP Server for multi-AI assistant coordination.
 * Refactored for Robust Host-Guest Architecture (v2).
 */
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

import { CONFIG, pkg, updateConfig, setHostServer, isHostAutoElection } from "./config/index.js";
import { StorageManager } from "./storage/index.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools/index.js";
import { listResources, getResourceContent } from "./resources/index.js";
import { sanitizeErrorMessage } from "./utils/error.js";
import { checkHostPermission } from "./utils/auth.js";
import { SERVICE_NAME } from "./constants.js";
import { startHost } from "./network/index.js";

// --- Request Buffer ---
// Holds JSON-RPC requests that need to be processed after election
type PendingRequest = {
    method: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: any;
    requestId?: string | number; // Added for tracing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (result: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reject: (error: any) => void;
};

class NexusServer {
    private server: Server;
    private currentProject: string | null = null;
    private sseTransports = new Map<string, SSEServerTransport>();

    // Election State
    private isElectionDone = false;
    private role: "HOST" | "GUEST" | "PENDING" = "PENDING";
    private requestBuffer: PendingRequest[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private guestClient: any = null; // Will be set if Guest

    constructor() {
        this.server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { resources: {}, tools: {}, prompts: {}, logging: {} } }
        );
        this.setupHandlers();
    }

    /**
     * Unified Logger
     * - stderr: For critical/boot logs (visible in terminal/logs)
     * - MCP Logging: For runtime logs (visible in IDE Output Channel)
     */
    private log(message: string, level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency" = "info") {
        // ALWAYS log to stderr for persistence/boot visibility
        console.error(message);

        // Send to MCP client if connected
        try {
            this.server.sendLoggingMessage({
                level,
                data: message
            });
        } catch {
            // SDK might not be ready or transport disconnected
        }
    }

    /**
     * "Static Pass-through" Handlers 
     * These handlers are registered immediately and can respond BEFORE election.
     * Dynamic requests are buffered.
     */
    private setupHandlers() {
        // --- 1. Static: Tool Listing (SAFE TO REPLY IMMEDIATELY) ---
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: TOOL_DEFINITIONS };
        });

        // --- 2. Static: Resource Listing (SAFE TO REPLY IMMEDIATELY) ---
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            try {
                return await listResources();
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Registry Error: ${sanitizeErrorMessage(msg)}`);
            }
        });

        // --- 3. Static: Prompt Listing ---
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

        // --- 4. Dynamic: Tool Calling (BUFFERED) ---
        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            // Attempt to retrieve Request ID from extra info or cast request
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const reqId = (request as any).id || (extra as any)?.id || `req-${Date.now()}`;

            if (!this.isElectionDone) {
                // Buffer!
                return new Promise((resolve, reject) => {
                    this.requestBuffer.push({
                        method: "tools/call",
                        params: request.params,
                        requestId: reqId,
                        resolve,
                        reject
                    });
                });
            }

            // Route based on Role
            if (this.role === "HOST") {
                return this.handleHostToolCall(request.params, reqId);
            } else {
                return this.forwardToHost("tools/call", request.params);
            }
        });

        // --- 5. Dynamic: Read Resource (BUFFERED) ---
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (!this.isElectionDone) {
                return new Promise((resolve, reject) => {
                    this.requestBuffer.push({
                        method: "resources/read",
                        params: request.params,
                        resolve,
                        reject
                    });
                });
            }

            if (this.role === "HOST") {
                return this.handleHostReadResource(request.params);
            } else {
                return this.forwardToHost("resources/read", request.params);
            }
        });

        // --- 6. Dynamic: Get Prompt (BUFFERED) ---
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            if (!this.isElectionDone) {
                return new Promise((resolve, reject) => {
                    this.requestBuffer.push({
                        method: "prompts/get",
                        params: request.params,
                        resolve,
                        reject
                    });
                });
            }

            if (this.role === "HOST") {
                // Local logic for prompt
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
- Role: Host
- Instance: ${CONFIG.instanceId}
- Port: ${CONFIG.port}
- Active Projects: ${projectCount}
- Recent Activity: ${logs.length} entries`
                            }
                        }]
                    };
                }
                throw new McpError(ErrorCode.InvalidRequest, `Prompt not found: ${request.params.name}`);
            } else {
                return this.forwardToHost("prompts/get", request.params);
            }
        });
    }

    // --- Host Logic Implementation ---

    private async handleHostReadResource(params: { uri: string }) {
        try {
            const result = await getResourceContent(params.uri, this.currentProject);
            if (!result) {
                throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${params.uri}`);
            }
            return { contents: [{ uri: params.uri, ...result }] };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new McpError(ErrorCode.InternalError, `Nexus Read Error: ${sanitizeErrorMessage(msg)}`);
        }
    }

    private async handleHostToolCall(params: { name: string; arguments?: Record<string, unknown> }, requestId?: string | number) {
        try {
            // Special handling for switch_project
            if (params.name === "switch_project") {
                const args = params.arguments as { project_id?: string };
                if (args.project_id) {
                    const manifest = await StorageManager.getProjectManifest(args.project_id);
                    if (manifest) {
                        this.currentProject = args.project_id;
                        return { content: [{ type: "text", text: `Switched to project: ${args.project_id}` }] };
                    }
                }
                return { content: [{ type: "text", text: `Project '${args.project_id}' not found.` }] };
            }

            // Host permission check
            const hostOnlyTools = ["delete_project", "rename_project", "clear_global_logs", "archive_meeting"];
            if (hostOnlyTools.includes(params.name)) {
                try {
                    checkHostPermission(params.name);
                } catch {
                    return { content: [{ type: "text", text: `[Permission Denied] Tool '${params.name}' requires Host privileges.` }] };
                }
            }

            const ctx = {
                currentProject: this.currentProject,
                setCurrentProject: (id: string) => { this.currentProject = id; },

                notifyResourceUpdate: (_uri: string) => {
                    // TODO: Notify all clients via SSE
                },
                requestId // Pass the ID to the context
            };
            const result = await handleToolCall(
                params.name,
                params.arguments as Record<string, unknown>,
                ctx
            );
            return result;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            const idPrefix = requestId ? `[Req:${requestId}] ` : "";
            // We return a text response for tool errors to maintain conversation flow, but flag it as error
            return {
                content: [{ type: "text", text: sanitizeErrorMessage(`${idPrefix}Tool Error: ${msg}`) }],
                isError: true
            };
        }
    }

    // --- Guest Logic Implementation ---

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async forwardToHost(method: string, params: any) {
        if (!this.guestClient) throw new Error("Guest Client not initialized");
        // Delegate to the Guest Client to making the HTTP call
        return this.guestClient.sendRequest(method, params);
    }

    // --- Lifecycle ---

    async run() {
        this.setupShutdownHandlers();

        // 1. IMMEDIATE: Connect Stdio (Handshake Ready)
        const transport = new StdioServerTransport();
        this.server.connect(transport).catch(err => {
            this.log(`[Nexus FATAL] Stdio transport failed: ${err}`, "error");
        });
        this.log(`[Nexus] Stdio Connected (Pending Election)...`);

        // 2. Start Election (Parallel)
        isHostAutoElection(CONFIG.rootStorage).then(async (election) => {
            this.log(`[Nexus] Election Finished. Role: ${election.isHost ? "HOST" : "GUEST"}`);

            this.role = election.isHost ? "HOST" : "GUEST";
            this.isElectionDone = true;

            // Global Config Update
            updateConfig({
                isHost: election.isHost,
                port: election.port,
                rootStorage: election.isHost ? CONFIG.rootStorage : (election.rootStorage || CONFIG.rootStorage)
            });

            if (election.isHost && election.server) {
                // --- HOST MODE ---
                if (election.server) setHostServer(election.server);
                await startHost(election.server, {
                    config: CONFIG,
                    pkg,
                    mcpServer: this.server,
                    sseTransports: this.sseTransports
                });

                // Flush Buffer (Process locally)
                this.flushBufferAsHost();

            } else {
                // --- GUEST MODE ---
                // We do NOT close the Stdio server. We keep it to receive requests from IDE.
                // But we start the Guest Client to forward those requests.
                const { createGuestClient } = await import("./network/guest.js");
                this.guestClient = createGuestClient(election.port, CONFIG.instanceId, () => {
                    this.handleReElection();
                });

                // Flush Buffer (Forward to Host)
                this.flushBufferAsGuest();
            }

        }).catch(err => {
            this.log(`[Nexus CRITICAL] Election failed: ${err}`, "error");
            // In case of failure, reject all buffered requests
            this.requestBuffer.forEach(req => req.reject(new Error("Nexus Startup Failed")));
            process.exit(1);
        });
    }

    private flushBufferAsHost() {
        this.log(`[Nexus] Flushing ${this.requestBuffer.length} buffered requests (Local)...`);
        while (this.requestBuffer.length > 0) {
            const req = this.requestBuffer.shift();
            if (!req) break;

            // Re-route to local handlers based on method
            if (req.method === "tools/call") {
                this.handleHostToolCall(req.params, req.requestId).then(req.resolve).catch(req.reject);
            } else if (req.method === "resources/read") {
                this.handleHostReadResource(req.params).then(req.resolve).catch(req.reject);
            } else {
                // Generic handling or error
                req.reject(new Error(`Unknown buffered method: ${req.method}`));
            }
        }
    }

    private flushBufferAsGuest() {
        this.log(`[Nexus] Flushing ${this.requestBuffer.length} buffered requests (Remote)...`);
        while (this.requestBuffer.length > 0) {
            const req = this.requestBuffer.shift();
            if (!req) break;
            this.forwardToHost(req.method, req.params).then(req.resolve).catch(req.reject);
        }
    }

    private setupShutdownHandlers() {
        const shutdown = async (signal: string) => {
            this.log(`\n[Nexus] Received ${signal}. Shutting down...`, "notice");
            try {
                if (this.role === "HOST") {
                    await StorageManager.addGlobalLog(`SYSTEM:${CONFIG.instanceId}`, `Nexus Host Terminated (${signal}).`, "UPDATE");
                }
                if (this.guestClient && typeof this.guestClient.close === 'function') {
                    this.guestClient.close();
                }
            } catch { /* ignore */ }
            process.exit(0);
        };
        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));
    }

    private handleReElection() {
        this.log(`[Nexus] Host Unreachable! Triggering Auto-Re-Election...`, "warning");

        // 1. Reset State
        this.role = "PENDING";
        this.isElectionDone = false;
        if (this.guestClient) {
            if (typeof this.guestClient.close === 'function') this.guestClient.close();
            this.guestClient = null;
        }

        // 2. Retry Election
        // Use a short random delay to avoid collision if multiple Guests retry at once
        const delay = Math.floor(Math.random() * 500) + 200;

        setTimeout(() => {
            // 3. Re-run startup logic (simplified inline version of run() election part)
            isHostAutoElection(CONFIG.rootStorage).then(async (election) => {
                this.log(`[Nexus] Re-Election Finished. New Role: ${election.isHost ? "HOST" : "GUEST"}`);
                this.role = election.isHost ? "HOST" : "GUEST";
                this.isElectionDone = true;

                updateConfig({
                    isHost: election.isHost,
                    port: election.port,
                    rootStorage: election.isHost ? CONFIG.rootStorage : (election.rootStorage || CONFIG.rootStorage)
                });

                if (election.isHost && election.server) {
                    if (election.server) setHostServer(election.server);
                    await startHost(election.server, {
                        config: CONFIG,
                        pkg,
                        mcpServer: this.server,
                        sseTransports: this.sseTransports
                    });
                    this.flushBufferAsHost();
                } else {
                    const { createGuestClient } = await import("./network/guest.js");
                    this.guestClient = createGuestClient(election.port, CONFIG.instanceId, () => {
                        this.handleReElection();
                    });
                    this.flushBufferAsGuest();
                }
            }).catch(err => {
                this.log(`[Nexus] Re-Election Failed: ${err}`, "error");
                // Retry again? Or just die? Let's retry indefinitely for now.
                setTimeout(() => this.handleReElection(), 2000);
            });
        }, delay);
    }
}

const server = new NexusServer();
server.run().catch(err => console.error("[Nexus FATAL]", err));

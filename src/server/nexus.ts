import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { CONFIG, pkg, setHostServer, isHostAutoElection, updateConfig } from "../config/index.js";
import { TOOL_DEFINITIONS } from "../tools/index.js";
import { listResources } from "../resources/index.js";
import { SERVICE_NAME } from "../constants.js";
import { startHost, createGuestClient } from "../network/index.js";

import { ToolDispatcher } from "./tools.js";
import { ResourceHandler } from "./resources.js";
import { RequestOrigin } from "../auth/index.js";

type PendingRequest = {
    method: string;
    params?: any;
    requestId?: string | number;
    resolve: (result: any) => void;
    reject: (error: any) => void;
};

export class NexusServer {
    private server: Server;
    private currentProject: string | null = null;
    private sseTransports = new Map<string, SSEServerTransport>();

    private isElectionDone = false;
    private role: "HOST" | "GUEST" | "PENDING" = "PENDING";
    private requestBuffer: PendingRequest[] = [];
    private guestClient: any = null;

    constructor() {
        this.server = new Server(
            { name: SERVICE_NAME, version: pkg.version },
            { capabilities: { resources: {}, tools: {}, prompts: {}, logging: {} } }
        );
        this.setupHandlers();
    }

    private log(message: string, level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency" = "info") {
        console.error(message);
        try {
            this.server.sendLoggingMessage({ level, data: message });
        } catch { }
    }

    private setupHandlers() {
        // 1. Tool Listing
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

        // 2. Resource Listing
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            try { return await listResources(); }
            catch (e: any) { throw new Error(`Nexus Resource List Error: ${e.message}`); }
        });

        // 3. Resource Reading
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            return ResourceHandler.read(request.params.uri, this.currentProject);
        });

        // 4. Tool Execution
        this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
            const reqId = (extra as any)?.requestId || "unknown";
            if (this.role === "HOST") {
                const sessionId = (extra as any)?.sessionId;
                let originOverride: RequestOrigin | undefined;
                if (sessionId && this.sseTransports.has(sessionId)) {
                    originOverride = RequestOrigin.REMOTE_GUEST;
                }

                return ToolDispatcher.execute(request.params.name, request.params.arguments, reqId, extra, {
                    currentProject: this.currentProject,
                    setCurrentProject: (id) => { this.currentProject = id; }
                }, originOverride);
            } else if (this.role === "GUEST") {
                return this.forwardToHost("tools/call", request.params);
            } else {
                return new Promise((resolve, reject) => {
                    this.requestBuffer.push({ method: "tools/call", params: request.params, requestId: reqId, resolve, reject });
                });
            }
        });
    }

    private async forwardToHost(method: string, params: any) {
        if (!this.guestClient) throw new Error("Guest Client not initialized");
        return this.guestClient.sendRequest(method, params);
    }

    private handleReElection() {
        this.log(`[Nexus Hub] Host lost. Starting Re-Election...`, "warning");
        this.role = "PENDING";
        this.isElectionDone = false;
        updateConfig({ isHost: false });
        if (this.guestClient) {
            this.guestClient.close();
            this.guestClient = null;
        }
        this.run();
    }

    private async startAsHost(election: any) {
        this.role = "HOST";
        updateConfig({ isHost: true });
        this.isElectionDone = true;
        setHostServer(election.server);
        await startHost(election.server, {
            config: CONFIG,
            pkg,
            mcpServer: this.server,
            sseTransports: this.sseTransports
        });
        this.flushBufferAsHost();
    }

    private startAsGuest(election: any) {
        this.role = "GUEST";
        updateConfig({ isHost: false });
        this.isElectionDone = true;
        this.guestClient = createGuestClient(election.port, CONFIG.instanceId, () => this.handleReElection());
        this.flushBufferAsGuest();
    }

    private flushBufferAsHost() {
        this.log(`[Nexus Hub] Host Active. Flushing ${this.requestBuffer.length} requests...`);
        while (this.requestBuffer.length > 0) {
            const req = this.requestBuffer.shift()!;
            if (req.method === "tools/call") {
                ToolDispatcher.execute(req.params.name, req.params.arguments, req.requestId, null, {
                    currentProject: this.currentProject,
                    setCurrentProject: (id) => { this.currentProject = id; }
                }).then(req.resolve).catch(req.reject);
            } else {
                req.reject(new Error(`Unknown buffered method: ${req.method}`));
            }
        }
    }

    private flushBufferAsGuest() {
        this.log(`[Nexus Hub] Guest Active. Flushing ${this.requestBuffer.length} requests...`);
        while (this.requestBuffer.length > 0) {
            const req = this.requestBuffer.shift()!;
            this.forwardToHost(req.method, req.params).then(req.resolve).catch(req.reject);
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        (transport as any)._isStdio = true;
        this.server.connect(transport).catch(err => {
            this.log(`[Nexus FATAL] Stdio transport failed: ${err}`, "error");
        });

        isHostAutoElection(CONFIG.rootStorage).then(async (election) => {
            if (election.isHost && election.server) {
                await this.startAsHost(election);
            } else {
                this.startAsGuest(election);
            }
        }).catch(err => {
            this.log(`[Nexus FATAL] Election error: ${err}`, "error");
            process.exit(1);
        });
    }
}

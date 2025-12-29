import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ErrorCode,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { CONFIG } from "./config.js";
import { StorageManager } from "./storage/index.js";
import { TOOL_DEFINITIONS, handleToolCall } from "./tools/index.js";
import { listResources, getResourceContent } from "./resources/index.js";

/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 * 
 * Modular MCP Server for multi-AI assistant coordination.
 */
class NexusServer {
    private server: Server;
    private currentProject: string | null = null;

    constructor() {
        this.server = new Server(
            { name: "n2n-nexus", version: "0.1.3" },
            { capabilities: { resources: {}, tools: {} } }
        );
        this.setupHandlers();
    }

    /**
     * Validates moderator permissions for admin tools.
     */
    private checkModerator(toolName: string) {
        if (CONFIG.moderatorId && CONFIG.instanceId !== CONFIG.moderatorId) {
            throw new McpError(ErrorCode.InvalidRequest, `Forbidden: ${toolName} requires Moderator rights.`);
        }
    }

    /**
     * Strips internal file paths from error messages to prevent path exposure to AI.
     */
    private sanitizeErrorMessage(msg: string): string {
        let sanitized = msg.replace(/[A-Za-z]:\\[^\s:]+/g, "[internal-path]");
        sanitized = sanitized.replace(/\/[^\s:]+\/[^\s:]*/g, "[internal-path]");
        sanitized = sanitized.replace(/\.\.[\\/][^\s]*/g, "[internal-path]");
        return sanitized;
    }

    private setupHandlers() {
        // --- Resource Listing ---
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            try {
                return await listResources();
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Registry Error: ${this.sanitizeErrorMessage(msg)}`);
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
                throw new McpError(ErrorCode.InternalError, `Nexus Resource Error: ${this.sanitizeErrorMessage(msg)}`);
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
                if (name.startsWith("moderator_")) this.checkModerator(name);

                const result = await handleToolCall(
                    name,
                    toolArgs as Record<string, unknown>,
                    {
                        currentProject: this.currentProject,
                        setCurrentProject: (id: string) => { this.currentProject = id; }
                    }
                );
                return result;
            } catch (error: unknown) {
                if (error instanceof McpError) throw error;
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{ type: "text", text: `Nexus Error: ${this.sanitizeErrorMessage(errorMessage)}` }]
                };
            }
        });
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}

const server = new NexusServer();
server.run().catch(console.error);

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
            { name: "n2n-nexus", version: "0.1.7" },
            { capabilities: { resources: {}, tools: {}, prompts: {} } }
        );
        this.setupHandlers();
    }

    /**
     * Validates moderator permissions for admin tools.
     */
    private checkModerator(toolName: string) {
        if (!CONFIG.isModerator) {
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
                    content: [{ type: "text", text: `Nexus Error: ${this.sanitizeErrorMessage(errorMessage)}` }]
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
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}

const server = new NexusServer();
server.run().catch(console.error);

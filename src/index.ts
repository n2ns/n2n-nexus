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
import { promises as fs } from "fs";

import { CONFIG } from "./config.js";
import { StorageManager } from "./storage.js";
import { ProjectManifest } from "./types.js";

/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 */
class NexusServer {
    private server: Server;
    private currentProject: string | null = null;

    constructor() {
        this.server = new Server(
            { name: "n2ns-nexus", version: "0.1.1" },
            { capabilities: { resources: {}, tools: {} } }
        );
        this.setupHandlers();
    }

    private checkModerator(toolName: string) {
        if (CONFIG.moderatorId && CONFIG.instanceId !== CONFIG.moderatorId) {
            throw new McpError(ErrorCode.InvalidRequest, `Forbidden: ${toolName} requires Moderator rights.`);
        }
    }

    /**
     * Strips internal file paths from error messages to prevent path exposure to AI.
     */
    private sanitizeErrorMessage(msg: string): string {
        // Remove Windows absolute paths (e.g., D:\path\to\file)
        let sanitized = msg.replace(/[A-Za-z]:\\[^\s:]+/g, "[internal-path]");
        // Remove Unix absolute paths (e.g., /home/user/path)
        sanitized = sanitized.replace(/\/[^\s:]+\/[^\s:]*/g, "[internal-path]");
        // Remove relative paths that look like file references
        sanitized = sanitized.replace(/\.\.[\\/][^\s]*/g, "[internal-path]");
        return sanitized;
    }

    private setupHandlers() {
        // --- Unified Resource Listing ---
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            try {
                const registry = await StorageManager.listRegistry();
                const projectIds = Object.keys(registry.projects);

                return {
                    resources: [
                        { uri: "mcp://chat/global", name: "Global Collaboration History", description: "Real-time discussion stream." },
                        { uri: "mcp://hub/registry", name: "Global Project Registry", description: "Consolidated index of all local projects." },
                        { uri: "mcp://docs/global-strategy", name: "Master Strategy Blueprint", description: "Top-level cross-project coordination." },
                        { uri: "mcp://nexus/session", name: "Current Session Info", description: "Your identity and role in this Nexus instance." },
                        ...projectIds.map(id => ({
                            uri: `mcp://hub/projects/${id}/manifest`,
                            name: `Manifest: ${id}`,
                            description: `Structured metadata (Tech stack, relations) for ${id}`
                        }))
                    ],
                    resourceTemplates: [
                        { uriTemplate: "mcp://hub/projects/{projectId}/internal-docs", name: "Internal Project Docs", description: "Markdown-based detailed implementation plans." }
                    ]
                };
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Registry Error: ${this.sanitizeErrorMessage(msg)}`);
            }
        });

        // --- Unified Resource Reading ---
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const { uri } = request.params;
            try {
                await StorageManager.init();

                if (uri === "mcp://chat/global") {
                    const text = await fs.readFile(StorageManager.globalDiscussion, "utf-8");
                    return { contents: [{ uri, mimeType: "application/json", text }] };
                }
                if (uri === "mcp://hub/registry") {
                    const text = await fs.readFile(StorageManager.registryFile, "utf-8");
                    return { contents: [{ uri, mimeType: "application/json", text }] };
                }
                if (uri === "mcp://docs/global-strategy") {
                    const text = await fs.readFile(StorageManager.globalBlueprint, "utf-8");
                    return { contents: [{ uri, mimeType: "text/markdown", text }] };
                }
                if (uri === "mcp://nexus/session") {
                    const isModerator = CONFIG.moderatorId ? CONFIG.instanceId === CONFIG.moderatorId : false;
                    const info = {
                        yourId: CONFIG.instanceId,
                        role: isModerator ? "Moderator" : "Regular",
                        isModerator: isModerator,
                        activeProject: this.currentProject || "None"
                    };
                    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(info, null, 2) }] };
                }
                // --- Dynamic Project Resources (Handles Namespaces) ---
                if (uri.startsWith("mcp://hub/projects/")) {
                    if (uri.endsWith("/manifest")) {
                        const id = uri.substring("mcp://hub/projects/".length, uri.lastIndexOf("/manifest"));
                        const manifest = await StorageManager.getProjectManifest(id);
                        if (manifest) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }] };
                    }
                    if (uri.endsWith("/internal-docs")) {
                        const id = uri.substring("mcp://hub/projects/".length, uri.lastIndexOf("/internal-docs"));
                        const text = await StorageManager.getProjectDocs(id);
                        if (text) return { contents: [{ uri, mimeType: "text/markdown", text }] };
                    }
                }

                throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
            } catch (error: unknown) {
                if (error instanceof McpError) throw error;
                const msg = error instanceof Error ? error.message : String(error);
                throw new McpError(ErrorCode.InternalError, `Nexus Resource Error: ${this.sanitizeErrorMessage(msg)}`);
            }
        });

        // --- Unified Toolset ---
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "register_session_context",
                    description: "Declare the project you are currently working on in this IDE session.",
                    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] }
                },
                {
                    name: "sync_project_assets",
                    description: "CRITICAL: Sync full project state. Both manifest and documentation are MANDATORY.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            manifest: {
                                type: "object",
                                description: "Full ProjectManifest metadata.",
                                properties: {
                                    id: { type: "string" },
                                    name: { type: "string" },
                                    description: { type: "string" },
                                    techStack: { type: "array", items: { type: "string" } },
                                    relations: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                targetId: { type: "string" },
                                                type: { type: "string", enum: ["dependency", "parent", "child", "related"] }
                                            },
                                            required: ["targetId", "type"]
                                        }
                                    },
                                    lastUpdated: { type: "string", description: "ISO timestamp." },
                                    repositoryUrl: { type: "string", description: "GitHub repository URL." },
                                    endpoints: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                name: { type: "string" },
                                                url: { type: "string" },
                                                description: { type: "string" }
                                            },
                                            required: ["name", "url", "description"]
                                        }
                                    },
                                    localPath: { type: "string", description: "Physical disk path of the project." },
                                    apiSpec: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                method: { type: "string" },
                                                path: { type: "string" },
                                                summary: { type: "string" }
                                            },
                                            required: ["method", "path", "summary"]
                                        }
                                    }
                                },
                                required: ["id", "name", "description", "techStack", "relations", "lastUpdated", "repositoryUrl", "localPath", "endpoints", "apiSpec"]
                            },
                            internalDocs: { type: "string", description: "Mandatory technical implementation guide (Markdown)." }
                        },
                        required: ["manifest", "internalDocs"]
                    }
                },
                {
                    name: "upload_project_asset",
                    description: "Upload a file. Both fileName and base64Content are MANDATORY.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            fileName: { type: "string" },
                            base64Content: { type: "string" }
                        },
                        required: ["fileName", "base64Content"]
                    }
                },
                {
                    name: "get_global_topology",
                    description: "Retrieve complete project relationship graph.",
                    inputSchema: { type: "object", properties: {} }
                },
                {
                    name: "read_project",
                    description: "Read project data by ID. Returns specific data slices without exposing internal paths.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectId: { type: "string", description: "Project identifier (e.g., 'n2ns.com.backend')" },
                            include: {
                                type: "string",
                                enum: ["manifest", "docs", "repo", "endpoints", "api", "relations", "summary", "all"],
                                description: "Data slice: manifest, docs, repo (git URL), endpoints, api (spec), relations, summary (brief), or all."
                            }
                        },
                        required: ["projectId"]
                    }
                },
                {
                    name: "post_global_discussion",
                    description: "Broadcast a message. Content is MANDATORY.",
                    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
                },
                {
                    name: "update_global_strategy",
                    description: "Overwrite master strategy. Content is MANDATORY.",
                    inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
                },
                {
                    name: "sync_global_doc",
                    description: "Create or update a global document. Returns the document ID.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            docId: { type: "string", description: "Unique document identifier (e.g., 'roadmap-2025', 'coding-standards')" },
                            title: { type: "string", description: "Human-readable document title" },
                            content: { type: "string", description: "Markdown content of the document" }
                        },
                        required: ["docId", "title", "content"]
                    }
                },
                {
                    name: "list_global_docs",
                    description: "List all global documents with their metadata (title, lastUpdated, updatedBy).",
                    inputSchema: { type: "object", properties: {} }
                },
                {
                    name: "read_global_doc",
                    description: "Read the content of a specific global document.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            docId: { type: "string", description: "Document identifier" }
                        },
                        required: ["docId"]
                    }
                },
                {
                    name: "update_project",
                    description: "Partially update a project's manifest. Only provided fields will be updated.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectId: { type: "string", description: "Project ID to update" },
                            patch: {
                                type: "object",
                                description: "Fields to update (e.g., description, techStack, endpoints, apiSpec, relations)",
                                additionalProperties: true
                            }
                        },
                        required: ["projectId", "patch"]
                    }
                },
                {
                    name: "rename_project",
                    description: "Rename a project ID with automatic cascading updates to all relation references.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            oldId: { type: "string", description: "Current project ID" },
                            newId: { type: "string", description: "New project ID" }
                        },
                        required: ["oldId", "newId"]
                    }
                },
                {
                    name: "moderator_maintenance",
                    description: "[ADMIN ONLY] Prune or clear logs. Both action and count are MANDATORY.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            action: { type: "string", enum: ["prune", "clear"] },
                            count: { type: "number", description: "Number of items (use 0 for 'clear')." }
                        },
                        required: ["action", "count"]
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: toolArgs } = request.params;

            try {
                await StorageManager.init();

                if (name.startsWith("moderator_")) this.checkModerator(name);

                switch (name) {
                    case "register_session_context": {
                        const args = toolArgs as { projectId: string };
                        if (!args?.projectId) throw new McpError(ErrorCode.InvalidParams, "Missing required parameter: projectId");
                        this.currentProject = args.projectId;
                        return { content: [{ type: "text", text: `Active Nexus Context: ${this.currentProject}` }] };
                    }

                    case "sync_project_assets": {
                        if (!this.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered. Call register_session_context first.");
                        const args = toolArgs as { manifest: ProjectManifest; internalDocs: string };
                        if (!args?.manifest || !args?.internalDocs) {
                            throw new McpError(ErrorCode.InvalidParams, "Both 'manifest' and 'internalDocs' are mandatory.");
                        }
                        const m = args.manifest;
                        if (!m.id || !m.name || !m.description || !m.techStack || !m.relations || !m.lastUpdated || !m.repositoryUrl || !m.localPath || !m.endpoints || !m.apiSpec) {
                            throw new McpError(ErrorCode.InvalidParams, "Project manifest incomplete. Required: id, name, description, techStack, relations, lastUpdated, repositoryUrl, localPath, endpoints, apiSpec.");
                        }

                        // Namespace Validation: Use '/' separator (e.g., n2ns.com/backend)
                        if (m.id.includes("..") || m.id.startsWith("/") || m.id.endsWith("/")) {
                            throw new McpError(ErrorCode.InvalidParams, "Project ID cannot contain '..' or start/end with '/'. Use '/' for namespacing (e.g., 'parent/child').");
                        }

                        // Validate localPath exists on disk
                        if (!await StorageManager.exists(m.localPath)) {
                            throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${m.localPath}'. Please provide a valid directory path.`);
                        }

                        await StorageManager.saveProjectManifest(m);
                        await StorageManager.saveProjectDocs(this.currentProject, args.internalDocs);

                        await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}@${this.currentProject}] Asset Sync: Full sync of manifest and docs.`);
                        return { content: [{ type: "text", text: "Project assets synchronized (Manifest + Docs)." }] };
                    }

                    case "upload_project_asset": {
                        if (!this.currentProject) throw new McpError(ErrorCode.InvalidRequest, "Session not registered.");
                        const args = toolArgs as { base64Content: string; fileName: string };
                        if (!args?.base64Content || !args?.fileName) {
                            throw new McpError(ErrorCode.InvalidParams, "Both 'base64Content' and 'fileName' are required.");
                        }
                        const buff = Buffer.from(args.base64Content, "base64");
                        await StorageManager.saveAsset(this.currentProject, args.fileName, buff);
                        return { content: [{ type: "text", text: `Asset '${args.fileName}' saved to project '${this.currentProject}'.` }] };
                    }

                    case "get_global_topology": {
                        const topo = await StorageManager.calculateTopology();
                        return { content: [{ type: "text", text: JSON.stringify(topo, null, 2) }] };
                    }

                    case "read_project": {
                        const args = toolArgs as { projectId: string; include?: string };
                        if (!args?.projectId) {
                            throw new McpError(ErrorCode.InvalidParams, "'projectId' is required.");
                        }
                        const include = args.include || "summary";
                        const manifest = await StorageManager.getProjectManifest(args.projectId);
                        if (!manifest) throw new McpError(ErrorCode.InvalidRequest, `Project '${args.projectId}' not found.`);

                        let result: Record<string, unknown> = { projectId: args.projectId };

                        switch (include) {
                            case "manifest":
                                result = { projectId: args.projectId, manifest };
                                break;
                            case "docs": {
                                const docs = await StorageManager.getProjectDocs(args.projectId);
                                result = { projectId: args.projectId, docs: docs || "(No documentation)" };
                                break;
                            }
                            case "repo":
                                result = { projectId: args.projectId, repositoryUrl: manifest.repositoryUrl };
                                break;
                            case "endpoints":
                                result = { projectId: args.projectId, endpoints: manifest.endpoints };
                                break;
                            case "api":
                                result = { projectId: args.projectId, apiSpec: manifest.apiSpec };
                                break;
                            case "relations":
                                result = { projectId: args.projectId, relations: manifest.relations };
                                break;
                            case "summary":
                                result = {
                                    projectId: args.projectId,
                                    name: manifest.name,
                                    description: manifest.description,
                                    techStack: manifest.techStack,
                                    repositoryUrl: manifest.repositoryUrl
                                };
                                break;
                            case "all": {
                                const docs = await StorageManager.getProjectDocs(args.projectId);
                                result = { projectId: args.projectId, manifest, docs: docs || "(No documentation)" };
                                break;
                            }
                            default:
                                throw new McpError(ErrorCode.InvalidParams, `Invalid 'include' value: ${include}`);
                        }
                        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                    }

                    case "post_global_discussion": {
                        const args = toolArgs as { message: string };
                        if (!args?.message) throw new McpError(ErrorCode.InvalidParams, "Message content cannot be empty.");
                        await StorageManager.addGlobalLog(`${CONFIG.instanceId}@${this.currentProject || "Global"}`, args.message);
                        return { content: [{ type: "text", text: "Message broadcasted." }] };
                    }

                    case "update_global_strategy": {
                        const args = toolArgs as { content: string };
                        if (!args?.content) throw new McpError(ErrorCode.InvalidParams, "Strategy content cannot be empty.");
                        await fs.writeFile(StorageManager.globalBlueprint, args.content);
                        await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Updated Coordination Strategy.`);
                        return { content: [{ type: "text", text: "Strategy updated." }] };
                    }

                    case "sync_global_doc": {
                        const args = toolArgs as { docId: string; title: string; content: string };
                        if (!args?.docId || !args?.title || !args?.content) {
                            throw new McpError(ErrorCode.InvalidParams, "All fields required: docId, title, content.");
                        }
                        await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, CONFIG.instanceId);
                        await StorageManager.addGlobalLog("SYSTEM", `[${CONFIG.instanceId}] Synced global doc: ${args.docId}`);
                        return { content: [{ type: "text", text: `Global document '${args.docId}' synchronized.` }] };
                    }

                    case "list_global_docs": {
                        const index = await StorageManager.listGlobalDocs();
                        return { content: [{ type: "text", text: JSON.stringify(index, null, 2) }] };
                    }

                    case "read_global_doc": {
                        const args = toolArgs as { docId: string };
                        if (!args?.docId) throw new McpError(ErrorCode.InvalidParams, "docId is required.");
                        const content = await StorageManager.getGlobalDoc(args.docId);
                        if (!content) throw new McpError(ErrorCode.InvalidRequest, `Global document '${args.docId}' not found.`);
                        return { content: [{ type: "text", text: content }] };
                    }

                    case "update_project": {
                        const args = toolArgs as { projectId: string; patch: Partial<ProjectManifest> };
                        if (!args?.projectId || !args?.patch) {
                            throw new McpError(ErrorCode.InvalidParams, "Both 'projectId' and 'patch' are required.");
                        }
                        if (args.patch.id) {
                            throw new McpError(ErrorCode.InvalidParams, "Cannot change 'id' via patch. Use 'rename_project' instead.");
                        }
                        // Validate localPath if being updated
                        if (args.patch.localPath && !await StorageManager.exists(args.patch.localPath)) {
                            throw new McpError(ErrorCode.InvalidParams, `localPath does not exist: '${args.patch.localPath}'. Please provide a valid directory path.`);
                        }
                        const _updated = await StorageManager.patchProjectManifest(args.projectId, args.patch);
                        const changedFields = Object.keys(args.patch).join(", ");
                        return { content: [{ type: "text", text: `Project '${args.projectId}' updated. Changed fields: ${changedFields}.` }] };
                    }

                    case "rename_project": {
                        const args = toolArgs as { oldId: string; newId: string };
                        if (!args?.oldId || !args?.newId) {
                            throw new McpError(ErrorCode.InvalidParams, "Both 'oldId' and 'newId' are required.");
                        }
                        // Validate newId format
                        if (args.newId.includes("..") || args.newId.startsWith("/") || args.newId.endsWith("/")) {
                            throw new McpError(ErrorCode.InvalidParams, "New ID cannot contain '..' or start/end with '/'.");
                        }
                        const updatedCount = await StorageManager.renameProject(args.oldId, args.newId);
                        return { content: [{ type: "text", text: `Project renamed: '${args.oldId}' → '${args.newId}'. Cascading updates: ${updatedCount} project(s).` }] };
                    }

                    case "moderator_maintenance": {
                        const args = toolArgs as { action: "prune" | "clear"; count: number };
                        if (!args.action || args.count === undefined) {
                            throw new McpError(ErrorCode.InvalidParams, "Both 'action' and 'count' are mandatory for maintenance.");
                        }

                        if (args.action === "clear") {
                            await StorageManager.clearGlobalLogs();
                            return { content: [{ type: "text", text: "History wiped." }] };
                        } else {
                            try {
                                await StorageManager.pruneGlobalLogs(args.count);
                                return { content: [{ type: "text", text: `Pruned ${args.count} logs.` }] };
                            } catch {
                                return { content: [{ type: "text", text: "Prune operation failed due to malformed logs or missing file." }] };
                            }
                        }
                    }

                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
                }
            } catch (error: unknown) {
                if (error instanceof McpError) throw error;
                const errorMessage = error instanceof Error ? error.message : String(error);
                // Convert internal storage/FS errors to readable MCP Errors (path-sanitized)
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

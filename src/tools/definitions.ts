/**
 * Tool definitions for MCP ListToolsRequestSchema
 */
export const TOOL_DEFINITIONS = [
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
];

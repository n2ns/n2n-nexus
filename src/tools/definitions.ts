/**
 * Optimized Tool Definitions for Token Economy
 * 
 * This file provides minimal, human-readable tool definitions that are
 * directly used by MCP ListTools. We avoid Zod's toJSONSchema() which
 * generates verbose output with redundant $schema declarations.
 * 
 * KEY OPTIMIZATIONS:
 * 1. No $schema on every inputSchema (saves ~50 chars/tool)
 * 2. Concise descriptions (half the length of originals)
 * 3. Internal tools (update_task) hidden from public listing
 * 4. No additionalProperties spam
 */

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

// Hidden tools that should not be exposed to clients
const HIDDEN_TOOLS = new Set(["update_task"]);

/**
 * Minimal tool definitions optimized for token economy.
 * Each tool has a concise description and a compact inputSchema.
 */
const ALL_TOOLS: ToolDefinition[] = [
    // --- Session & Identity ---
    {
        name: "register_session_context",
        description: "Declare active project. Format: [prefix]_[name] (e.g., 'web_example.com', 'mcp_nexus').",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "Project ID with prefix (web_, api_, mcp_, etc.)" }
            },
            required: ["projectId"]
        }
    },

    // --- Project Assets ---
    {
        name: "sync_project_assets",
        description: "[ASYNC] Sync full project manifest + internal docs. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: {
                manifest: {
                    type: "object",
                    description: "Project metadata (id, name, description, techStack, relations, endpoints, apiSpec)",
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        techStack: { type: "array", items: { type: "string" } },
                        relations: { type: "array", items: { type: "object" } },
                        repositoryUrl: { type: "string" },
                        localPath: { type: "string" },
                        endpoints: { type: "array", items: { type: "object" } },
                        apiSpec: { type: "array", items: { type: "object" } }
                    },
                    required: ["id", "name", "description", "techStack", "relations", "repositoryUrl", "localPath", "endpoints", "apiSpec"]
                },
                internalDocs: { type: "string", description: "Markdown implementation guide" }
            },
            required: ["manifest", "internalDocs"]
        }
    },
    {
        name: "upload_project_asset",
        description: "Upload binary file (base64) to active project's asset folder.",
        inputSchema: {
            type: "object",
            properties: {
                fileName: { type: "string", description: "Safe filename (no path traversal)" },
                base64Content: { type: "string" }
            },
            required: ["fileName", "base64Content"]
        }
    },
    {
        name: "update_project",
        description: "Patch project manifest fields (partial update).",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                patch: { type: "object", description: "Fields to update" }
            },
            required: ["projectId", "patch"]
        }
    },
    {
        name: "rename_project",
        description: "[ASYNC] Rename project ID with cascading relation updates. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: {
                oldId: { type: "string" },
                newId: { type: "string" }
            },
            required: ["oldId", "newId"]
        }
    },

    // --- Global Collaboration ---
    {
        name: "get_global_topology",
        description: "Default: project list + stats. With projectId: detailed subgraph.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "Focus on specific project (optional)" }
            }
        }
    },
    {
        name: "send_message",
        description: "Post message to active meeting or global chat.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string" },
                category: { type: "string", enum: ["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT"] }
            },
            required: ["message"]
        }
    },
    {
        name: "read_messages",
        description: "Read unread messages (auto-incremental per IDE instance).",
        inputSchema: {
            type: "object",
            properties: {
                count: { type: "integer", default: 10 },
                meetingId: { type: "string" }
            }
        }
    },
    {
        name: "update_global_strategy",
        description: "Overwrite master strategy document.",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string" }
            },
            required: ["content"]
        }
    },
    {
        name: "sync_global_doc",
        description: "Create/update a global shared document.",
        inputSchema: {
            type: "object",
            properties: {
                docId: { type: "string" },
                title: { type: "string" },
                content: { type: "string" }
            },
            required: ["docId", "title", "content"]
        }
    },

    // --- Meeting Management ---
    {
        name: "start_meeting",
        description: "Start new meeting session. Returns meeting ID.",
        inputSchema: {
            type: "object",
            properties: {
                topic: { type: "string" }
            },
            required: ["topic"]
        }
    },
    {
        name: "end_meeting",
        description: "[Moderator] End active meeting. Locks history.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string" },
                summary: { type: "string" }
            }
        }
    },
    {
        name: "archive_meeting",
        description: "[Moderator] Archive closed meeting. Read-only after.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string" }
            },
            required: ["meetingId"]
        }
    },
    {
        name: "reopen_meeting",
        description: "Reopen closed/archived meeting.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string" }
            },
            required: ["meetingId"]
        }
    },

    // --- Task Management (Phase 2) ---
    {
        name: "create_task",
        description: "[ASYNC] Create background task. Returns taskId for polling.",
        inputSchema: {
            type: "object",
            properties: {
                source_meeting_id: { type: "string", description: "Link to meeting for traceability" },
                metadata: { type: "object" },
                ttl: { type: "integer", description: "TTL in milliseconds" }
            }
        }
    },
    {
        name: "get_task",
        description: "Get task status and progress by ID.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string" }
            },
            required: ["taskId"]
        }
    },
    {
        name: "list_tasks",
        description: "List tasks with optional status filter.",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
                limit: { type: "integer", default: 50 }
            }
        }
    },
    {
        name: "update_task",
        description: "[INTERNAL] Update task state. For workers only.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string" },
                status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
                progress: { type: "number", minimum: 0, maximum: 1 },
                result_uri: { type: "string" },
                error_message: { type: "string" }
            },
            required: ["taskId"]
        }
    },
    {
        name: "cancel_task",
        description: "Cancel pending/running task.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string" }
            },
            required: ["taskId"]
        }
    },

    // --- Admin (Moderator Only) ---
    {
        name: "moderator_maintenance",
        description: "[Moderator] Manage logs: 'prune' oldest N or 'clear' all.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["prune", "clear"] },
                count: { type: "integer", minimum: 0 }
            },
            required: ["action", "count"]
        }
    },
    {
        name: "moderator_delete_project",
        description: "[ASYNC][Moderator] Delete project. Irreversible. Returns taskId.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" }
            },
            required: ["projectId"]
        }
    }
];

/**
 * Public tool definitions (excludes internal tools).
 * This is what gets returned to MCP ListTools.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = ALL_TOOLS.filter(
    tool => !HIDDEN_TOOLS.has(tool.name)
);

/**
 * Full tool definitions (includes internal tools).
 * Used internally for handler registration.
 */
export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = ALL_TOOLS;

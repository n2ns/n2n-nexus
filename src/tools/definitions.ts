/**
 * Tool definitions for MCP ListToolsRequestSchema
 */
export const TOOL_DEFINITIONS = [
    {
        name: "register_session_context",
        description: "[IDENTITY] Declare the PROJECT identity. Format: [prefix]_[technical-identifier]. (e.g., 'web_datafrog.io', 'mcp_nexus-core').",
        inputSchema: { 
            type: "object", 
            properties: { 
                projectId: { 
                    type: "string", 
                    description: "Strict flat identifier. MUST start with a type-prefix (web_, api_, chrome_, vscode_, mcp_, android_, ios_, flutter_, desktop_, lib_, bot_, infra_, doc_) followed by an underscore and a technical name (Domain for websites, Repo name/Slug for code). Use kebab-case. No hierarchy dots except in domains." 
                } 
            }, 
            required: ["projectId"] 
        }
    },
    {
        name: "sync_project_assets",
        description: "CRITICAL: [PREREQUISITE: register_session_context] Sync full project state. Both manifest and documentation are MANDATORY.",
        inputSchema: {
            type: "object",
            properties: {
                manifest: {
                    type: "object",
                    description: "Full ProjectManifest metadata.",
                    properties: {
                        id: { type: "string", description: "Project ID. MUST follow '[prefix]_[technical-name]' format and match active session." },
                        name: { type: "string" },
                        description: { type: "string" },
                        techStack: { type: "array", items: { type: "string" } },
                        relations: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    targetId: { type: "string", description: "ID of the target project (e.g., 'acme.auth-service')." },
                                    type: { type: "string", enum: ["dependency", "parent", "child", "related"] }
                                },
                                required: ["targetId", "type"]
                            }
                        },
                        lastUpdated: { type: "string", description: "ISO timestamp (e.g., 2025-12-29T...)." },
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
        description: "Upload a binary file (images, PDFs, etc.) to the current project's asset folder. Requires active session (call register_session_context first). Returns the relative path of the saved file.",
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
        description: "Retrieve complete project relationship graph. Returns { nodes: [{ id, name }], edges: [{ from, to, type }] }. Use this to visualize dependencies.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "list_projects",
        description: "List all existing projects registered in the Nexus Hub. Use this to find correct IDs before performing project-specific operations.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "read_project",
        description: "Read project data by ID. Returns specific data slices without exposing internal paths.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "Project ID (e.g., 'web_datafrog.io', 'mcp_nexus-hub')." },
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
        description: "Post a message to the Nexus collaboration space. If an active meeting exists, the message is automatically routed to that meeting. Otherwise, it goes to the global discussion log. Use this for proposals, decisions, or general coordination.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "The core content of your speech, proposal, or announcement." },
                category: { 
                    type: "string", 
                    enum: ["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT"],
                    description: "The nature of this message. DECISION messages are auto-extracted into meeting decisions[]."
                }
            },
            required: ["message"]
        }
    },
    {
        name: "read_recent_discussion",
        description: "Read recent messages. Automatically reads from the active meeting if one exists, otherwise reads from global discussion log.",
        inputSchema: {
            type: "object",
            properties: {
                count: { type: "number", description: "Number of recent messages to retrieve (defaults to 10).", default: 10 },
                meetingId: { type: "string", description: "Optional: Read from a specific meeting instead of the active one." }
            }
        }
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
                projectId: { type: "string", description: "Project ID to update (e.g., 'web_datafrog.io')." },
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
                oldId: { type: "string", description: "Current project ID (e.g., 'web_oldname.com')." },
                newId: { type: "string", description: "New project ID following the '[prefix]_[name]' standard." }
            },
            required: ["oldId", "newId"]
        }
    },
    {
        name: "moderator_maintenance",
        description: "[ADMIN ONLY] Manage global discussion logs. 'prune' removes the oldest N entries (keeps newest). 'clear' wipes all logs (use count=0). Returns summary of removed entries. Irreversible.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["prune", "clear"] },
                count: { type: "number", description: "Number of items (use 0 for 'clear')." }
            },
            required: ["action", "count"]
        }
    },
    {
        name: "moderator_delete_project",
        description: "[ADMIN ONLY] Completely remove a project, its manifest, and all its assets from Nexus Hub. Irreversible.",
        inputSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "The ID of the project to destroy." }
            },
            required: ["projectId"]
        }
    },
    // --- Meeting Management Tools (Phase 1) ---
    {
        name: "start_meeting",
        description: "Start a new meeting session. Creates a dedicated file for the meeting. Returns the meeting ID and details.",
        inputSchema: {
            type: "object",
            properties: {
                topic: { type: "string", description: "The topic/agenda for this meeting (e.g., 'Architecture Review', 'Sprint Planning')." }
            },
            required: ["topic"]
        }
    },
    {
        name: "end_meeting",
        description: "End an active meeting. Locks the session for further messages. Returns suggested sync targets based on participants.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string", description: "The ID of the meeting to end. If omitted, ends the current active meeting." },
                summary: { type: "string", description: "Optional summary of the meeting conclusions." }
            }
        }
    },
    {
        name: "list_meetings",
        description: "List all meetings with optional status filter. Returns meeting metadata without full message history.",
        inputSchema: {
            type: "object",
            properties: {
                status: { 
                    type: "string", 
                    enum: ["active", "closed", "archived"],
                    description: "Filter by meeting status. Omit to list all."
                }
            }
        }
    },
    {
        name: "read_meeting",
        description: "Read the full content of a specific meeting including all messages and decisions.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string", description: "The ID of the meeting to read." }
            },
            required: ["meetingId"]
        }
    },
    {
        name: "archive_meeting",
        description: "Archive a closed meeting. Archived meetings are read-only and excluded from active queries.",
        inputSchema: {
            type: "object",
            properties: {
                meetingId: { type: "string", description: "The ID of the closed meeting to archive." }
            },
            required: ["meetingId"]
        }
    }
];

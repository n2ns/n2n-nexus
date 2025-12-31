import { promises as fs } from "fs";

import { CONFIG } from "../config.js";
import { StorageManager } from "../storage/index.js";
import { UnifiedMeetingStore } from "../storage/store.js";

/**
 * Resource content providers for MCP ReadResourceRequestSchema
 */
export async function getResourceContent(
    uri: string,
    currentProject: string | null
): Promise<{ mimeType: string; text: string } | null> {
    await StorageManager.init();

    if (uri === "mcp://nexus/chat/global") {
        const text = await fs.readFile(StorageManager.globalDiscussion, "utf-8");
        return { mimeType: "application/json", text };
    }

    if (uri === "mcp://nexus/hub/registry") {
        const text = await fs.readFile(StorageManager.registryFile, "utf-8");
        return { mimeType: "application/json", text };
    }

    if (uri === "mcp://nexus/docs/global-strategy") {
        const text = await fs.readFile(StorageManager.globalBlueprint, "utf-8");
        return { mimeType: "text/markdown", text };
    }

    if (uri === "mcp://nexus/session") {
        const info = {
            yourId: CONFIG.instanceId,
            role: CONFIG.isModerator ? "Moderator" : "Regular",
            isModerator: CONFIG.isModerator,
            activeProject: currentProject || "None"
        };
        return { mimeType: "application/json", text: JSON.stringify(info, null, 2) };
    }

    if (uri === "mcp://nexus/status") {
        const state = await UnifiedMeetingStore.getState();
        const storageInfo = await UnifiedMeetingStore.getStorageInfo();
        const status = {
            status: "online",
            version: "0.2.0",
            ...storageInfo,
            active_meetings_count: state.activeMeetings.length,
            default_meeting: state.defaultMeetingId
        };
        return { mimeType: "application/json", text: JSON.stringify(status, null, 2) };
    }

    if (uri === "mcp://nexus/active-meeting") {
        const active = await UnifiedMeetingStore.getActiveMeeting();
        if (active) return { mimeType: "application/json", text: JSON.stringify(active, null, 2) };
        return { mimeType: "application/json", text: JSON.stringify({ message: "No active meeting" }, null, 2) };
    }

    if (uri === "mcp://nexus/meetings/list") {
        const meetings = await UnifiedMeetingStore.listMeetings();
        return { mimeType: "application/json", text: JSON.stringify(meetings, null, 2) };
    }

    if (uri === "mcp://nexus/docs/list") {
        const docs = await StorageManager.listGlobalDocs();
        return { mimeType: "application/json", text: JSON.stringify(docs, null, 2) };
    }

    if (uri.startsWith("mcp://nexus/meetings/")) {
        const meetingId = uri.substring("mcp://nexus/meetings/".length);
        const mtg = await UnifiedMeetingStore.getMeeting(meetingId);
        if (mtg) return { mimeType: "application/json", text: JSON.stringify(mtg, null, 2) };
    }

    if (uri.startsWith("mcp://nexus/docs/")) {
        const docId = uri.substring("mcp://nexus/docs/".length);
        if (docId === "global-strategy") {
            const text = await fs.readFile(StorageManager.globalBlueprint, "utf-8");
            return { mimeType: "text/markdown", text };
        }
        const text = await StorageManager.getGlobalDoc(docId);
        if (text) return { mimeType: "text/markdown", text };
    }

    // Dynamic Project Resources (Handles Namespaces)
    if (uri.startsWith("mcp://nexus/projects/")) {
        if (uri.endsWith("/manifest")) {
            const id = uri.substring("mcp://nexus/projects/".length, uri.lastIndexOf("/manifest"));
            const manifest = await StorageManager.getProjectManifest(id);
            if (manifest) return { mimeType: "application/json", text: JSON.stringify(manifest, null, 2) };
        }
        if (uri.endsWith("/internal-docs")) {
            const id = uri.substring("mcp://nexus/projects/".length, uri.lastIndexOf("/internal-docs"));
            const text = await StorageManager.getProjectDocs(id);
            if (text) return { mimeType: "text/markdown", text };
        }
    }

    return null;
}

/**
 * Returns the list of available resources for MCP ListResourcesRequestSchema
 */
export async function listResources() {
    const registry = await StorageManager.listRegistry();
    const projectIds = Object.keys(registry.projects);

    return {
        resources: [
            { uri: "mcp://nexus/chat/global", name: "Global Collaboration History", description: "Real-time discussion stream." },
            { uri: "mcp://nexus/hub/registry", name: "Global Project Registry", description: "Consolidated index of all local projects." },
            { uri: "mcp://nexus/docs/list", name: "Global Documentation Index", description: "List of all shared cross-project documents." },
            { uri: "mcp://nexus/docs/global-strategy", name: "Master Strategy Blueprint", description: "Top-level cross-project coordination document." },
            { uri: "mcp://nexus/meetings/list", name: "Meeting Registry", description: "Consolidated list of active and closed meetings." },
            { uri: "mcp://nexus/session", name: "Current Session Info", description: "Your identity and role in this Nexus instance." },
            { uri: "mcp://nexus/status", name: "System Status & Storage Mode", description: "Backend storage mode (sqlite/json) and active meeting counts." },
            { uri: "mcp://nexus/active-meeting", name: "Current Active Meeting", description: "Full transcript and participants of the current default meeting." },
            ...projectIds.map(id => {
                const prefix = id.split("_")[0];
                const typeLabel = {
                    web: "🌐 Website", api: "⚙️ API", chrome: "🧩 Chrome Ext",
                    vscode: "💻 VSCode Ext", mcp: "🔌 MCP Server", android: "📱 Android",
                    ios: "🍎 iOS", flutter: "📲 Flutter", desktop: "🖥️ Desktop",
                    lib: "📦 Library", bot: "🤖 Bot", infra: "☁️ Infra", doc: "📄 Docs"
                }[prefix] || "📁 Project";
                return {
                    uri: `mcp://nexus/projects/${id}/manifest`,
                    name: `${typeLabel}: ${id}`,
                    description: `Structured metadata (Tech stack, relations) for ${id}`
                };
            })
        ],
        resourceTemplates: [
            { uriTemplate: "mcp://nexus/projects/{projectId}/internal-docs", name: "Internal Project Docs", description: "Markdown-based detailed implementation plans." },
            { uriTemplate: "mcp://nexus/docs/{docId}", name: "Specific Global Doc", description: "Read a specific document from the global index." },
            { uriTemplate: "mcp://nexus/meetings/{meetingId}", name: "Meeting Insights", description: "Full transcript and decisions for a specific meeting." }
        ]
    };
}

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
            version: "0.2.1",
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
 * 
 * OPTIMIZATION: No longer lists individual projects dynamically.
 * Uses resourceTemplates instead - AI should query registry first.
 */
export async function listResources() {
    const registry = await StorageManager.listRegistry();
    const projectCount = Object.keys(registry.projects).length;

    return {
        resources: [
            // Core resources (static, always available)
            { uri: "mcp://nexus/chat/global", name: "Global Chat", description: "Real-time discussion stream." },
            { uri: "mcp://nexus/hub/registry", name: "Project Registry", description: `Index of ${projectCount} registered projects. Read this first to discover project IDs.` },
            { uri: "mcp://nexus/docs/list", name: "Docs Index", description: "List of shared cross-project documents." },
            { uri: "mcp://nexus/docs/global-strategy", name: "Strategy Blueprint", description: "Top-level coordination document." },
            { uri: "mcp://nexus/meetings/list", name: "Meetings List", description: "Active and closed meetings." },
            { uri: "mcp://nexus/session", name: "Session Info", description: "Your identity and role." },
            { uri: "mcp://nexus/status", name: "System Status", description: "Storage mode and active meeting count." },
            { uri: "mcp://nexus/active-meeting", name: "Active Meeting", description: "Current default meeting transcript." }
        ],
        resourceTemplates: [
            // Project resources - use registry to discover IDs first
            { uriTemplate: "mcp://nexus/projects/{projectId}/manifest", name: "Project Manifest", description: "Metadata for a specific project. Get projectId from registry." },
            { uriTemplate: "mcp://nexus/projects/{projectId}/internal-docs", name: "Project Docs", description: "Internal implementation guide for a project." },
            { uriTemplate: "mcp://nexus/docs/{docId}", name: "Global Doc", description: "Read a specific shared document." },
            { uriTemplate: "mcp://nexus/meetings/{meetingId}", name: "Meeting Details", description: "Full transcript for a specific meeting." }
        ]
    };
}

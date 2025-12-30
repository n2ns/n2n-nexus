import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { StorageManager } from "../src/storage/index.js";
import { getResourceContent } from "../src/resources/index.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

const TEST_ROOT = path.join(process.cwd(), "test-storage-handlers");
CONFIG.rootStorage = TEST_ROOT;

describe("Tool Handlers", () => {
    let mockContext: ToolContext;

    beforeEach(async () => {
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        await StorageManager.init();

        mockContext = {
            currentProject: null,
            setCurrentProject: vi.fn((id) => { mockContext.currentProject = id; }),
            notifyResourceUpdate: vi.fn(),
        };
    });

    it("should register session context", async () => {
        const result = await handleToolCall("register_session_context", { projectId: "web_test.io" }, mockContext);
        expect(result.content[0].text).toContain("web_test.io");
        expect(mockContext.setCurrentProject).toHaveBeenCalledWith("web_test.io");
        expect(mockContext.currentProject).toBe("web_test.io");
    });

    it("should handle global discussion with category", async () => {
        await handleToolCall("post_global_discussion", { message: "Meeting start", category: "MEETING_START" }, mockContext);
        
        const logs = await StorageManager.getRecentLogs(1);
        expect(logs[0].text).toBe("Meeting start");
        expect(logs[0].category).toBe("MEETING_START");
        expect(mockContext.notifyResourceUpdate).toHaveBeenCalledWith("mcp://chat/global");
    });

    it("should rename project and notify updates", async () => {
        // Create a project first
        await handleToolCall("register_session_context", { projectId: "web_old.io" }, mockContext);
        await handleToolCall("sync_project_assets", {
            manifest: {
                id: "web_old.io",
                name: "Old",
                description: "D",
                techStack: [],
                relations: [],
                lastUpdated: new Date().toISOString(),
                repositoryUrl: "",
                localPath: TEST_ROOT,
                endpoints: [],
                apiSpec: []
            },
            internalDocs: "# Docs"
        }, mockContext);

        const result = await handleToolCall("rename_project", { oldId: "web_old.io", newId: "web_new.io" }, mockContext);
        expect(result.content[0].text).toContain("web_new.io");
        
        expect(mockContext.notifyResourceUpdate).toHaveBeenCalledWith("mcp://hub/registry");
        expect(mockContext.notifyResourceUpdate).toHaveBeenCalledWith("mcp://hub/projects/web_new.io/manifest");
        
        const oldExists = await StorageManager.getProjectManifest("web_old.io");
        const newManifest = await StorageManager.getProjectManifest("web_new.io");
        expect(oldExists).toBeNull();
        expect(newManifest?.id).toBe("web_new.io");
    });

    it("should delete project via tool", async () => {
         await handleToolCall("register_session_context", { projectId: "web_to-delete.io" }, mockContext);
         await handleToolCall("sync_project_assets", {
            manifest: {
                id: "web_to-delete.io",
                name: "DeleteMe",
                description: "D",
                techStack: [],
                relations: [],
                lastUpdated: new Date().toISOString(),
                repositoryUrl: "",
                localPath: TEST_ROOT,
                endpoints: [],
                apiSpec: []
            },
            internalDocs: "# Docs"
        }, mockContext);

        expect(await StorageManager.getProjectManifest("web_to-delete.io")).not.toBeNull();

        await handleToolCall("delete_project", { projectId: "web_to-delete.io" }, mockContext);

        expect(await StorageManager.getProjectManifest("web_to-delete.io")).toBeNull();
        expect(mockContext.notifyResourceUpdate).toHaveBeenCalledWith("mcp://hub/registry");
    });

    it("should list projects", async () => {
        await handleToolCall("register_session_context", { projectId: "web_a.io" }, mockContext);
        await handleToolCall("sync_project_assets", {
            manifest: {
                id: "web_a.io", name: "A", description: "D", techStack: [], relations: [],
                lastUpdated: new Date().toISOString(), repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
            },
            internalDocs: "# Docs"
        }, mockContext);

        const result = await handleToolCall("list_projects", {}, mockContext);
        const projects = JSON.parse(result.content[0].text);
        expect(projects).toHaveLength(1);
        expect(projects[0].id).toBe("web_a.io");
    });

    describe("Moderator permissions", () => {
        it("should allow moderator_maintenance when isModerator is true", async () => {
            CONFIG.isModerator = true;

            // Add some logs first
            await handleToolCall("post_global_discussion", { message: "Test message" }, mockContext);

            const result = await handleToolCall("moderator_maintenance", { action: "clear", count: 0 }, mockContext);
            expect(result.content[0].text).toContain("wiped");
        });

        it("should verify CONFIG.isModerator flag behavior", () => {
            // Test the flag is properly set
            CONFIG.isModerator = true;
            expect(CONFIG.isModerator).toBe(true);

            CONFIG.isModerator = false;
            expect(CONFIG.isModerator).toBe(false);
        });
    });

    describe("Session resource", () => {
        it("should return Moderator role when isModerator is true", async () => {
            CONFIG.isModerator = true;
            CONFIG.instanceId = "Master-AI";

            const result = await getResourceContent("mcp://nexus/session", "web_test.io");
            expect(result).not.toBeNull();

            const info = JSON.parse(result!.text);
            expect(info.yourId).toBe("Master-AI");
            expect(info.role).toBe("Moderator");
            expect(info.isModerator).toBe(true);
            expect(info.activeProject).toBe("web_test.io");
        });

        it("should return Regular role when isModerator is false", async () => {
            CONFIG.isModerator = false;
            CONFIG.instanceId = "Assistant-AI";

            const result = await getResourceContent("mcp://nexus/session", null);
            expect(result).not.toBeNull();

            const info = JSON.parse(result!.text);
            expect(info.yourId).toBe("Assistant-AI");
            expect(info.role).toBe("Regular");
            expect(info.isModerator).toBe(false);
            expect(info.activeProject).toBe("None");
        });
    });
});

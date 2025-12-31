import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-tasks");
CONFIG.rootStorage = TEST_ROOT;

describe("Task Management (Phase 2)", () => {
    let mockContext: ToolContext;
    let createdTaskId: string;

    beforeEach(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "projects"), { recursive: true });
        
        await StorageManager.init();

        mockContext = {
            currentProject: "mcp_test-project",
            setCurrentProject: () => {},
            notifyResourceUpdate: () => {},
        };
    });

    afterEach(async () => {
        closeDatabase();
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    it("should create a new task", async () => {
        const result = await handleToolCall("create_task", {
            metadata: { action: "test_sync", target: "project_x" }
        }, mockContext);
        
        const response = JSON.parse(result.content[0].text);
        expect(response.message).toBe("Task created successfully.");
        expect(response.task_id).toMatch(/^task_\d+_[a-z0-9]+$/);
        expect(response.status).toBe("pending");
        
        createdTaskId = response.task_id;
    });

    it("should create task without meeting link", async () => {
        const result = await handleToolCall("create_task", {
            metadata: { type: "asset_sync" }
        }, mockContext);
        
        const response = JSON.parse(result.content[0].text);
        expect(response.source_meeting_id).toBeNull();
    });

    it("should get task by ID", async () => {
        // First create a task
        const createResult = await handleToolCall("create_task", {
            metadata: { test: true }
        }, mockContext);
        const createResponse = JSON.parse(createResult.content[0].text);
        const taskId = createResponse.task_id;
        
        // Then retrieve it
        const result = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(result.content[0].text);
        
        expect(task.id).toBe(taskId);
        expect(task.status).toBe("pending");
        expect(task.progress).toBe(0);
        expect(task.metadata.test).toBe(true);
    });

    it("should return error for non-existent task", async () => {
        await expect(
            handleToolCall("get_task", { taskId: "task_nonexistent_xxxx" }, mockContext)
        ).rejects.toThrow("not found");
    });

    it("should list tasks", async () => {
        // Create multiple tasks
        await handleToolCall("create_task", { metadata: { n: 1 } }, mockContext);
        await handleToolCall("create_task", { metadata: { n: 2 } }, mockContext);
        await handleToolCall("create_task", { metadata: { n: 3 } }, mockContext);
        
        const result = await handleToolCall("list_tasks", {}, mockContext);
        const response = JSON.parse(result.content[0].text);
        
        expect(response.count).toBeGreaterThanOrEqual(3);
        expect(response.tasks.length).toBeGreaterThanOrEqual(3);
        expect(response.tasks[0]).toHaveProperty("id");
        expect(response.tasks[0]).toHaveProperty("status");
        expect(response.tasks[0]).toHaveProperty("progress");
    });

    it("should filter tasks by status", async () => {
        // Create a task and update its status
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        await handleToolCall("update_task", {
            taskId,
            status: "running",
            progress: 0.5
        }, mockContext);
        
        // List running tasks only
        const result = await handleToolCall("list_tasks", { status: "running" }, mockContext);
        const response = JSON.parse(result.content[0].text);
        
        expect(response.tasks.every((t: any) => t.status === "running")).toBe(true);
    });

    it("should update task status and progress", async () => {
        // Create task
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        // Update progress
        const updateResult = await handleToolCall("update_task", {
            taskId,
            status: "running",
            progress: 0.75
        }, mockContext);
        
        const updateResponse = JSON.parse(updateResult.content[0].text);
        expect(updateResponse.status).toBe("running");
        expect(updateResponse.progress).toBe(0.75);
        
        // Verify via get
        const getResult = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(getResult.content[0].text);
        expect(task.status).toBe("running");
        expect(task.progress).toBe(0.75);
    });

    it("should complete task with result URI", async () => {
        // Create and complete
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        await handleToolCall("update_task", {
            taskId,
            status: "completed",
            progress: 1.0,
            result_uri: "mcp://nexus/projects/test/manifest"
        }, mockContext);
        
        const getResult = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(getResult.content[0].text);
        
        expect(task.status).toBe("completed");
        expect(task.progress).toBe(1);
        expect(task.result_uri).toBe("mcp://nexus/projects/test/manifest");
    });

    it("should fail task with error message", async () => {
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        await handleToolCall("update_task", {
            taskId,
            status: "failed",
            error_message: "Connection timeout after 30s"
        }, mockContext);
        
        const getResult = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(getResult.content[0].text);
        
        expect(task.status).toBe("failed");
        expect(task.error_message).toBe("Connection timeout after 30s");
    });

    it("should cancel a pending task", async () => {
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        const cancelResult = await handleToolCall("cancel_task", { taskId }, mockContext);
        const response = JSON.parse(cancelResult.content[0].text);
        
        expect(response.status).toBe("cancelled");
        
        // Verify via get
        const getResult = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(getResult.content[0].text);
        expect(task.status).toBe("cancelled");
    });

    it("should cancel a running task", async () => {
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        // Start it
        await handleToolCall("update_task", { taskId, status: "running" }, mockContext);
        
        // Then cancel
        const cancelResult = await handleToolCall("cancel_task", { taskId }, mockContext);
        expect(JSON.parse(cancelResult.content[0].text).status).toBe("cancelled");
    });

    it("should not cancel a completed task", async () => {
        const createResult = await handleToolCall("create_task", {}, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        // Complete it
        await handleToolCall("update_task", { taskId, status: "completed" }, mockContext);
        
        // Try to cancel
        await expect(
            handleToolCall("cancel_task", { taskId }, mockContext)
        ).rejects.toThrow("Cannot cancel");
    });

    it("should preserve metadata through task lifecycle", async () => {
        const metadata = {
            operation: "sync_assets",
            projectId: "web_test.io",
            files: ["a.png", "b.jpg"],
            retryCount: 0
        };
        
        const createResult = await handleToolCall("create_task", { metadata }, mockContext);
        const taskId = JSON.parse(createResult.content[0].text).task_id;
        
        // Update status
        await handleToolCall("update_task", { taskId, status: "running" }, mockContext);
        
        // Verify metadata is preserved
        const getResult = await handleToolCall("get_task", { taskId }, mockContext);
        const task = JSON.parse(getResult.content[0].text);
        
        expect(task.metadata.operation).toBe("sync_assets");
        expect(task.metadata.files).toEqual(["a.png", "b.jpg"]);
    });
});

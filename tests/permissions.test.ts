import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { StorageManager } from "../src/storage/index.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

const TEST_ROOT = path.join(process.cwd(), "test-permissions");
CONFIG.rootStorage = TEST_ROOT;

describe("Meeting Permission Tests", () => {
    let mockContextA: ToolContext;
    let mockContextB: ToolContext;

    beforeEach(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "projects"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "meetings"), { recursive: true });
        
        await StorageManager.init();

        CONFIG.instanceId = "Daisy-AI";
        CONFIG.isModerator = false;

        mockContextA = {
            currentProject: "web_project-a.io",
            setCurrentProject: vi.fn(),
            notifyResourceUpdate: vi.fn(),
        };

        mockContextB = {
            currentProject: "web_project-b.io",
            setCurrentProject: vi.fn(),
            notifyResourceUpdate: vi.fn(),
        };
    });

    afterEach(async () => {
        closeDatabase();
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    it("should allow initiator to end their meeting", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // AI A ends meeting -> Success
        const endResult = await handleToolCall("end_meeting", { meetingId }, mockContextA);
        expect(JSON.parse(endResult.content[0].text).status).toBe("closed");
    });

    it("should deny other agents from ending a meeting they didn't start", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // AI B tries to end meeting A -> Failure
        try {
            await handleToolCall("end_meeting", { meetingId }, mockContextB);
            throw new Error("Should have failed");
        } catch (e: any) {
            expect(e.message).toContain("Permission denied");
            expect(e.message).toContain("Only initiator");
        }
    });

    it("should allow moderator to end any meeting", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // Elevate AI B to Moderator
        CONFIG.isModerator = true;
        
        // AI B ends meeting A -> Success (Moderator bypass)
        const endResult = await handleToolCall("end_meeting", { meetingId }, mockContextB);
        expect(JSON.parse(endResult.content[0].text).status).toBe("closed");
        
        CONFIG.isModerator = false;
    });

    it("should deny other agents from archiving a meeting they didn't start", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // AI A ends meeting
        await handleToolCall("end_meeting", { meetingId }, mockContextA);

        // AI B tries to archive meeting A -> Failure
        try {
            await handleToolCall("archive_meeting", { meetingId }, mockContextB);
            throw new Error("Should have failed");
        } catch (e: any) {
            expect(e.message).toContain("Permission denied");
        }

        // AI A archives -> Success
        const arcResult = await handleToolCall("archive_meeting", { meetingId }, mockContextA);
        expect(JSON.parse(arcResult.content[0].text).status).toBe("archived");
    });
});

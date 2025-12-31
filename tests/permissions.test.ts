import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { StorageManager } from "../src/storage/index.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-permissions");
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

    it("should deny initiator from ending their meeting if not moderator", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // AI A ends meeting -> Failure (Strict Moderator check)
        try {
            await handleToolCall("end_meeting", { meetingId }, mockContextA);
            throw new Error("Should have failed");
        } catch (e: any) {
            expect(e.message).toContain("Permission denied");
            expect(e.message).toContain("Only moderators");
        }
    });

    it("should deny other agents from ending a meeting they didn't start", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // AI B tries to end meeting A -> Failure (Strict Moderator check)
        try {
            await handleToolCall("end_meeting", { meetingId }, mockContextB);
            throw new Error("Should have failed");
        } catch (e: any) {
            expect(e.message).toContain("Permission denied");
            expect(e.message).toContain("Only moderators");
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

    it("should enforce moderator-only for archive and reopen", async () => {
        // AI A starts meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContextA);
        const meetingId = JSON.parse(startResult.content[0].text).meetingId;

        // End as moderator
        CONFIG.isModerator = true;
        await handleToolCall("end_meeting", { meetingId }, mockContextB);
        CONFIG.isModerator = false;

        // Try to archive as initiator (AI A) -> Failure
        try {
            await handleToolCall("archive_meeting", { meetingId }, mockContextA);
            throw new Error("Should have failed");
        } catch (e: any) {
            expect(e.message).toContain("Permission denied");
        }

        // Try to reopen as initiator (AI A) -> Success (Relaxed per user request)
        const reopenResult = await handleToolCall("reopen_meeting", { meetingId }, mockContextA);
        expect(JSON.parse(reopenResult.content[0].text).status).toBe("active");

        // Archive as moderator -> Success
        CONFIG.isModerator = true;
        await handleToolCall("end_meeting", { meetingId }, mockContextB);
        const archiveResult = await handleToolCall("archive_meeting", { meetingId }, mockContextB);
        expect(JSON.parse(archiveResult.content[0].text).status).toBe("archived");
        
        CONFIG.isModerator = false;
    });
});

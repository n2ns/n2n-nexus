import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { StorageManager } from "../src/storage/index.js";
import { UnifiedMeetingStore } from "../src/storage/store.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

const TEST_ROOT = path.join(process.cwd(), "test-meetings");
CONFIG.rootStorage = TEST_ROOT;

describe("Meeting Integration Tests", () => {
    let mockContext: ToolContext;

    beforeEach(async () => {
        // Ensure clean state
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "projects"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "meetings"), { recursive: true }); // For JSON fallback
        
        await StorageManager.init();

        mockContext = {
            currentProject: "web_test.io",
            setCurrentProject: vi.fn(),
            notifyResourceUpdate: vi.fn(),
        };
    });

    afterEach(async () => {
        closeDatabase();
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    it("should handle full meeting lifecycle via tools", async () => {
        // 1. Start Meeting
        const startResult = await handleToolCall("start_meeting", { topic: "Architecture Review" }, mockContext);
        const startData = JSON.parse(startResult.content[0].text);
        expect(startData.topic).toBe("Architecture Review");
        expect(startData.meetingId).toBeDefined();
        const meetingId = startData.meetingId;

        // Verify ID format (timestamp-slug-suffix)
        expect(meetingId).toMatch(/^\d{14}-[a-z0-9-]+-[a-z0-9]{4}$/);

        // 2. Post Discussion (Auto-routed to active meeting)
        await handleToolCall("send_message", { 
            message: "We should use SQLite", 
            category: "PROPOSAL" 
        }, mockContext);

        await handleToolCall("send_message", { 
            message: "Agreed. Let's do it.", 
            category: "DECISION" 
        }, mockContext);

        // 3. Read Meeting and verify messages/decisions
        const readResult = await handleToolCall("read_meeting", { meetingId }, mockContext);
        const meeting = JSON.parse(readResult.content[0].text);
        
        expect(meeting.messages).toHaveLength(2);
        expect(meeting.messages[0].text).toBe("We should use SQLite");
        expect(meeting.decisions).toContain("Agreed. Let's do it.");
        expect(meeting.participants).toContain(`${CONFIG.instanceId}@web_test.io`);

        // 4. End Meeting
        const endResult = await handleToolCall("end_meeting", { 
            meetingId, 
            summary: "Decided to use SQLite for better concurrency." 
        }, mockContext);
        const endData = JSON.parse(endResult.content[0].text);
        expect(endData.status).toBe("closed");
        expect(endData.decisionsCount).toBe(1);

        // 5. List Meetings
        const listResult = await handleToolCall("list_meetings", { status: "closed" }, mockContext);
        const listData = JSON.parse(listResult.content[0].text);
        expect(listData.some((m: any) => m.id === meetingId)).toBe(true);

        // 6. Archive Meeting
        await handleToolCall("archive_meeting", { meetingId }, mockContext);
        const finalRead = await handleToolCall("read_meeting", { meetingId }, mockContext);
        expect(JSON.parse(finalRead.content[0].text).status).toBe("archived");
    });

    it("should correctly handle Chinese topics and slugs", async () => {
        const startResult = await handleToolCall("start_meeting", { topic: "中文会议测试" }, mockContext);
        const startData = JSON.parse(startResult.content[0].text);
        
        // Slug should be base64 fallback since there are no alpha-numeric chars
        expect(startData.meetingId).toContain("-");
        // Verify it doesn't crash
        expect(startData.topic).toBe("中文会议测试");
    });

    it("should fallback to global log when no active meeting exists", async () => {
        // No meeting started
        await handleToolCall("send_message", { message: "Global broadcast" }, mockContext);
        
        // Reading recent discussion should return from global discussion.json
        const result = await handleToolCall("read_messages", { count: 5 }, mockContext);
        const data = JSON.parse(result.content[0].text);
        expect(data.source).toBe("global");
        expect(data.messages[0].text).toBe("Global broadcast");
    });

    it("should handle simultaneous meetings and default routing", async () => {
        // Start Meeting A
        const resA = await handleToolCall("start_meeting", { topic: "Meeting A" }, mockContext);
        const idA = JSON.parse(resA.content[0].text).meetingId;

        // Start Meeting B (B becomes default)
        const resB = await handleToolCall("start_meeting", { topic: "Meeting B" }, mockContext);
        const idB = JSON.parse(resB.content[0].text).meetingId;

        // Post message (should go to B)
        await handleToolCall("send_message", { message: "MSG for B" }, mockContext);

        const readB = await handleToolCall("read_meeting", { meetingId: idB }, mockContext);
        expect(JSON.parse(readB.content[0].text).messages[0].text).toBe("MSG for B");

        // End B... A should become default again
        await handleToolCall("end_meeting", { meetingId: idB }, mockContext);
        
        await handleToolCall("send_message", { message: "MSG back to A" }, mockContext);
        
        const readA = await handleToolCall("read_meeting", { meetingId: idA }, mockContext);
        expect(JSON.parse(readA.content[0].text).messages[0].text).toBe("MSG back to A");
    });

    it("should handle rapid fire message bursts (Concurrency Stress Test)", async () => {
        const res = await handleToolCall("start_meeting", { topic: "Stress Test" }, mockContext);
        const meetingId = JSON.parse(res.content[0].text).meetingId;

        const BURST_SIZE = 20;
        const tasks = [];
        for (let i = 0; i < BURST_SIZE; i++) {
            tasks.push(handleToolCall("send_message", { 
                message: `Burst message ${i}` 
            }, mockContext));
        }

        await Promise.all(tasks);

        const final = await handleToolCall("read_meeting", { meetingId }, mockContext);
        const meeting = JSON.parse(final.content[0].text);
        expect(meeting.messages).toHaveLength(BURST_SIZE);
        
        // Check all messages are there
        const texts = meeting.messages.map((m: any) => m.text);
        for (let i = 0; i < BURST_SIZE; i++) {
            expect(texts).toContain(`Burst message ${i}`);
        }
    });
});

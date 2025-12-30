import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UnifiedMeetingStore } from "../src/storage/store.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

const TEST_ROOT = path.join(process.cwd(), "test-fallback");
CONFIG.rootStorage = TEST_ROOT;

// We need to reset the lazy-loaded store in store.ts for this test
// Since the module is already loaded in other tests, we might need a way to reset it.
// In Vitest, modules are shared. We can try to use vi.doMock before importing.

describe("Storage Fallback Mechanism", () => {
    beforeEach(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "global"), { recursive: true });
        await fs.mkdir(path.join(TEST_ROOT, "meetings"), { recursive: true });
        
        // Reset store.ts internal state if possible (this is tricky with ES modules)
        // Usually you'd use vi.isolateModules() but it's not always reliable with mixed imports.
    });

    afterEach(async () => {
        closeDatabase();
    });

    it("should report storage mode correctly", async () => {
        const info = await UnifiedMeetingStore.getStorageInfo();
        // By default better-sqlite3 should be available in this environment
        expect(info.storage_mode).toBe("sqlite");
        expect(info.is_degraded).toBe(false);
    });

    // To truly test fallback, we'd need to mock the dynamic import of './sqlite-meeting.js'
    // in store.ts. 
});

describe("JSON Store Functional Test", () => {
    // Let's test the JSON store directly to ensure it's still healthy
    it("should work correctly in JSON mode independently", async () => {
        const { MeetingStore } = await import("../src/storage/meetings.js");
        
        const meeting = await MeetingStore.startMeeting("JSON Test", "Agent@Test");
        expect(meeting.topic).toBe("JSON Test");
        expect(meeting.id).toBeDefined();

        await MeetingStore.addMessage(meeting.id, {
            timestamp: new Date().toISOString(),
            from: "Agent@Test",
            text: "Hello JSON"
        });

        const retrieved = await MeetingStore.getMeeting(meeting.id);
        expect(retrieved?.messages[0].text).toBe("Hello JSON");
        
        const meetings = await MeetingStore.listMeetings();
        expect(meetings.some(m => m.id === meeting.id)).toBe(true);
    });
});

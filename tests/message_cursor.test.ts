import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";

import { UnifiedMeetingStore } from "../src/storage/store.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "message-cursor");

describe("Message Cursor Multi-Instance Behavior", () => {
    beforeEach(async () => {
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        if (typeof (UnifiedMeetingStore as unknown as { _reset?: () => void })._reset === "function") {
            (UnifiedMeetingStore as unknown as { _reset: () => void })._reset();
        }
    });

    it("should return unread messages for same meeting per instance cursor", async () => {
        const info = await UnifiedMeetingStore.getStorageInfo();
        if (info.storage_mode === "json") {
            return;
        }

        const meeting = await UnifiedMeetingStore.startMeeting("Cursor Meeting", "IDE-A");

        await UnifiedMeetingStore.addMessage(meeting.id, {
            timestamp: new Date().toISOString(),
            from: "IDE-A",
            text: "A: hello",
            category: "UPDATE"
        });

        const first = await UnifiedMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(first).toHaveLength(1);

        await UnifiedMeetingStore.addMessage(meeting.id, {
            timestamp: new Date().toISOString(),
            from: "IDE-C",
            text: "B: update",
            category: "UPDATE"
        });

        const second = await UnifiedMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(second).toHaveLength(1);

        const third = await UnifiedMeetingStore.getRecentMessages(10, meeting.id, "IDE-B");
        expect(third).toHaveLength(0);
    });
});

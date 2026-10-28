// send_message / read_messages: unread cursors per instance (no hooks) for meetings and global chat,
// and host_maintenance on global chat. Meetings started here are ended again, so
// send_message without meetingId goes to global chat in the other tests.
import { describe, expect, it } from "vitest";
import { HOOK, useHost } from "./harness.js";

type Read = { source: string; mode: string; messages: { text: string; from: string; senderName: string | null; category: string | null }[]; count: number };

const host = useHost();
const read = async (instanceId: string, count: number, meetingId?: string) => {
    const res = await host.callTool<Read>("read_messages", { count, ...(meetingId ? { meetingId } : {}) }, instanceId);
    expect(res.status, res.body).toBe(200);
    return res.payload.result!;
};
const texts = async (instanceId: string, count: number, meetingId?: string) => (await read(instanceId, count, meetingId)).messages.map((m) => m.text);
const sendGlobal = async (instanceId: string, message: string, category?: string) => {
    const res = await host.callTool<{ sentTo: string }>("send_message", { message, ...(category ? { category } : {}) }, instanceId);
    expect(res.payload.result?.sentTo).toBe("global");
};

describe("meeting messages", () => {
    it("keeps an unread cursor per instance and meeting", async () => {
        const meetingId = (await host.callTool<{ meetingId: string }>("start_meeting", { topic: "Daemon Cursor" }, "IDE-A")).payload.result!.meetingId;

        const firstSend = await host.callTool<{ ok: boolean; sentTo: string; meetingId?: string }>("send_message", { message: "first", meetingId }, "IDE-C");
        expect(firstSend.status).toBe(200);
        expect(firstSend.payload.result).toMatchObject({ ok: true, sentTo: "meeting", meetingId });

        const firstRead = await read("IDE-B", 10, meetingId);
        expect(firstRead.source).toBe("meeting");
        expect(firstRead.messages.map((m) => m.text)).toEqual(["first"]);

        expect((await host.callTool("send_message", { message: "second", meetingId }, "IDE-C")).status).toBe(200);
        expect(await texts("IDE-B", 10, meetingId)).toEqual(["second"]);
        expect(await texts("IDE-B", 10, meetingId)).toEqual([]);

        // A reader's own messages are not unread for it; history includes them.
        await host.callTool("send_message", { message: "own", meetingId }, "IDE-B");
        expect(await texts("IDE-B", 10, meetingId)).toEqual([]);
        const history = await host.callTool<Read>("read_messages", { meetingId, latest: true, count: 1 }, "IDE-B");
        expect(history.payload.result).toMatchObject({ mode: "history", messages: [{ text: "own", from: "IDE-B", senderName: null }] });

        await host.callTool("end_meeting", { meetingId }, "IDE-A");
    });

    it("gives every instance its own cursor: one reader's reads do not hide messages from another", async () => {
        const meetingId = (await host.callTool<{ meetingId: string }>("start_meeting", { topic: "Cursor Meeting" }, "IDE-A")).payload.result!.meetingId;
        await host.callTool("send_message", { message: "A: hello", category: "UPDATE", meetingId }, "IDE-A");
        expect(await texts("IDE-B", 10, meetingId)).toHaveLength(1);

        await read("IDE-C", 10, meetingId);
        await host.callTool("send_message", { message: "B: update", category: "UPDATE", meetingId }, "IDE-C");
        expect(await texts("IDE-B", 10, meetingId)).toHaveLength(1);
        expect(await texts("IDE-B", 10, meetingId)).toHaveLength(0);
        expect(await texts("IDE-D", 10, meetingId)).toEqual(["A: hello", "B: update"]);

        await host.callTool("end_meeting", { meetingId }, "IDE-A");
    });

    it("refuses a post while messages of others are unread, attaching them, and lets the next one through with a note", async () => {
        const meetingId = (await host.callTool<{ meetingId: string }>("start_meeting", { topic: "Read First" }, "IDE-A")).payload.result!.meetingId;
        await host.callTool("send_message", { message: "A says", meetingId }, "IDE-A");
        type Sent = { ok: boolean; refused?: boolean; messageId?: number; unread?: { id: number; text: string; cut: boolean }[] };
        const refused = await host.callTool<Sent>("send_message", { message: "B says", meetingId }, "IDE-B");
        expect(refused.status, refused.body).toBe(200);
        expect(refused.payload.result).toMatchObject({ ok: false, refused: true, unread: [{ id: 1, text: "A says", cut: false }] });
        expect(refused.payload.result!.messageId).toBeUndefined();
        // The attached message counts as read.
        expect(await texts("IDE-B", 10, meetingId)).toEqual([]);
        expect((await host.callTool<Sent>("send_message", { message: "B says", meetingId }, "IDE-B")).payload.result).toMatchObject({ ok: true, messageId: 2 });

        await host.callTool("send_message", { message: "A again", meetingId }, "IDE-A"); // A has not read #2: refused
        await host.callTool("send_message", { message: "B more", meetingId }, "IDE-B"); // #3
        const passed = await host.callTool<Sent>("send_message", { message: "A again", meetingId }, "IDE-A");
        expect(passed.payload.result).toMatchObject({ ok: true, messageId: 4 });
        const last = await host.callTool<Read>("read_messages", { meetingId, latest: true, count: 1 }, "IDE-A");
        expect(last.payload.result!.messages[0].text).toBe(`A again\n\n${HOOK.texts.sentWithUnread.replace("%s", "#3")}`);

        await host.callTool("end_meeting", { meetingId }, "IDE-A");
    });
});

describe("global chat", () => {
    it("returns only unread messages per instance and advances the cursor", async () => {
        await host.callTool("host_maintenance", { action: "clear" }, "admin");
        await sendGlobal("A", "one", "UPDATE");
        await sendGlobal("B", "two");

        const first = await read("reader", 10);
        expect(first.source).toBe("global");
        expect(first.messages.map((m) => m.text)).toEqual(["one", "two"]);
        expect(first.messages[0]).toMatchObject({ from: "A", category: "UPDATE" });

        expect(await texts("reader", 10)).toHaveLength(0);
        expect(await texts("other-reader", 10)).toHaveLength(2);

        await sendGlobal("A", "three");
        expect(await texts("reader", 10)).toEqual(["three"]);
    });

    it("honours the count limit without skipping messages", async () => {
        await host.callTool("host_maintenance", { action: "clear" }, "admin");
        for (let i = 0; i < 5; i++) await sendGlobal("A", `m${i}`);
        expect(await texts("r", 2)).toEqual(["m0", "m1"]);
        expect(await texts("r", 2)).toEqual(["m2", "m3"]);
        expect(await texts("r", 2)).toEqual(["m4"]);
    });

    it("prunes the oldest messages and clears all", async () => {
        await host.callTool("host_maintenance", { action: "clear" }, "admin");
        for (let i = 0; i < 3; i++) await sendGlobal("A", `p${i}`);
        const pruned = await host.callTool<{ removed: number; remaining: number }>("host_maintenance", { action: "prune", count: 1 }, "admin");
        expect(pruned.payload.result).toMatchObject({ ok: true, removed: 1, remaining: 2 });
        expect(await texts("fresh-reader", 10)).toEqual(["p1", "p2"]);
        const cleared = await host.callTool<{ removed: number; remaining: number }>("host_maintenance", { action: "clear" }, "admin");
        expect(cleared.payload.result).toMatchObject({ ok: true, removed: 2, remaining: 0 });
        expect(await texts("another-reader", 10)).toEqual([]);
    });
});

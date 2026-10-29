// Meeting lifecycle and routing. Each test leaves no meeting active.
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_WAIT_EVENT, agentKit, context, ids } from "./agents.js";
import { until, useHost } from "./harness.js";

type Listed = {
    count: number; activeMeetingId: string | null;
    meetings: { id: string; status: string; participants: string[]; messageCount: number; decisionCount: number; summary?: string }[];
};

const host = useHost();
const start = async (topic: string, instanceId: string) =>
    (await host.callTool<{ meetingId: string }>("start_meeting", { topic }, instanceId)).payload.result!.meetingId;
const listed = async (args: Record<string, unknown> = {}) => (await host.callTool<Listed>("list_meetings", args)).payload.result!;

describe("meeting tools", () => {
    it("start -> end -> archive -> reopen, by any adapter instance", async () => {
        const started = await host.callTool<{ meetingId: string; topic: string; status: string }>("start_meeting", { topic: "Release plan" }, "ide-a");
        expect(started.status).toBe(200);
        expect(started.payload.result).toMatchObject({ ok: true, topic: "Release plan", status: "active" });
        const meetingId = started.payload.result!.meetingId;

        const ended = await host.callTool<{ status: string; summary: string }>("end_meeting", { meetingId, summary: "shipped" }, "ide-b");
        expect(ended.payload.result).toMatchObject({ status: "closed", summary: "shipped" });

        const archived = await host.callTool<{ status: string }>("archive_meeting", { meetingId }, "ide-b");
        expect(archived.payload.result?.status).toBe("archived");

        const reopened = await host.callTool<{ status: string }>("reopen_meeting", { meetingId }, "ide-b");
        expect(reopened.payload.result?.status).toBe("active");
        expect((await listed()).meetings.find((m) => m.id === meetingId)?.status).toBe("active");

        await host.callTool("end_meeting", { meetingId }, "ide-a");
        expect((await host.callTool("archive_meeting", { meetingId: "no-such-meeting" }, "ide-a")).status).toBe(400);
        const noActive = await host.callTool("end_meeting", {}, "ide-a");
        expect(noActive.status).toBe(400);
        expect(noActive.payload.error).toContain("No active meeting");
    });

    it("join and leave: members are listed with how they take part", async () => {
        const meetingId = await start("Members", "ide-j");
        type Joined = { mode: string; approver: string; identity: string; delivery: string };
        const joined = await host.callTool<Joined>("join_meeting", { meetingId, mode: "async" }, "ide-k");
        expect(joined.payload.result).toMatchObject({ mode: "async", approver: "optional", identity: "instance", delivery: "unavailable" });
        type Member = { id: string; mode: string; approver: string };
        const members = async () => ((await listed()).meetings.find((m) => m.id === meetingId) as unknown as { members: Member[] }).members;
        expect((await members()).map((m) => [m.id, m.mode, m.approver])).toEqual([["ide-j", "active", "required"], ["ide-k", "async", "optional"]]);
        expect((await host.callTool("leave_meeting", { meetingId }, "ide-k")).status).toBe(200);
        expect((await host.callTool("leave_meeting", { meetingId }, "ide-k")).status).toBe(400);
        expect((await members()).map((m) => m.id)).toEqual(["ide-j"]);
        await host.callTool("end_meeting", { meetingId }, "ide-j");
    });

    it("numbers each meeting's messages from 1", async () => {
        const first = await start("Numbers one", "ide-n");
        const second = await start("Numbers two", "ide-n");
        const send = async (meetingId: string, message: string) =>
            (await host.callTool<{ messageId: number }>("send_message", { meetingId, message }, "ide-m")).payload.result!.messageId;
        expect([await send(first, "a"), await send(second, "b"), await send(first, "c")]).toEqual([1, 1, 2]);
        const read = await host.callTool<{ messages: { id: number; text: string }[] }>("read_messages", { meetingId: first, afterId: 1 }, "ide-n");
        expect(read.payload.result!.messages.map((m) => [m.id, m.text])).toEqual([[2, "c"]]);
        for (const meetingId of [first, second]) await host.callTool("end_meeting", { meetingId }, "ide-n");
    });

    it("routes send_message to the active meeting, an explicit meeting, or global chat", async () => {
        const meetingId = await start("Routing", "ide-a");

        // An active meeting receives messages without any prior setup.
        const toActive = await host.callTool<{ sentTo: string; meetingId: string }>("send_message", { message: "hello" }, "ide-b");
        expect(toActive.payload.result).toMatchObject({ sentTo: "meeting", meetingId });

        await host.callTool("end_meeting", { meetingId }, "ide-a");

        const toGlobal = await host.callTool<{ sentTo: string }>("send_message", { message: "after" }, "ide-b");
        expect(toGlobal.payload.result?.sentTo).toBe("global");

        const toClosed = await host.callTool("send_message", { message: "late", meetingId }, "ide-b");
        expect(toClosed.status).toBe(400);
        expect(toClosed.payload.error).toContain("closed");

        const unread = await host.callTool<{ count: number }>("read_messages", { meetingId, count: 10 }, "ide-c");
        expect(unread.payload.result?.count).toBe(1);
    });

    it("lists meetings with counts, summary and status filter", async () => {
        const a = await start("First", "ide-a");
        await host.callTool("send_message", { message: "p", category: "PROPOSAL" }, "ide-b");
        await host.callTool("read_messages", { meetingId: a }, "ide-a");
        await host.callTool("send_message", { message: "d", category: "DECISION" }, "ide-a");
        await host.callTool("end_meeting", { meetingId: a, summary: "agreed" }, "ide-a");
        const b = await start("Second", "ide-b");

        const all = await listed();
        expect(all.activeMeetingId).toBe(b);
        const first = all.meetings.find((m) => m.id === a)!;
        expect(first).toMatchObject({ status: "closed", messageCount: 2, decisionCount: 1, summary: "agreed" });
        expect([...first.participants].sort()).toEqual(["ide-a", "ide-b"]);

        const active = await listed({ status: "active", limit: 5 });
        expect(active.meetings.map((m) => m.id)).toEqual([b]);
        expect(active.count).toBe(1);

        await host.callTool("end_meeting", { meetingId: b }, "ide-b");
        expect((await listed()).activeMeetingId).toBeNull();
    });
});

describe("meetings per conversation", () => {
    const kit = agentKit(host);
    afterEach(() => kit.endSessions());
    type Read = { identity: string; messages: { text: string; from: string; senderName: string | null; senderMachine: string | null }[] };

    it("gives two Claude conversations on one adapter instance their own cursors and names them as senders", async () => {
        const s = ids();
        const [a, b] = [s("a"), s("b")];
        for (const id of [a, b]) await kit.hook("claude", "SessionStart", id);
        await kit.hook("claude", "UserPromptSubmit", a, { machine: { hostname: "box-a", platform: "wsl", environment: "Ubuntu_26", utcOffset: 0 } });
        const meetingId = await start("Per session", "ide-a");
        for (const message of ["one", "two"]) expect((await host.callTool("send_message", { message, meetingId }, "ide-a")).status).toBe(200);

        // Both conversations share the claudeTool instance and each read every message.
        for (const id of [a, b]) {
            const res = await kit.claudeTool<Read>(id, "read_messages", { meetingId });
            expect(res.status, res.body).toBe(200);
            expect(res.payload.result!.identity).toBe("session");
            expect(res.payload.result!.messages.map((m) => m.text)).toEqual(["one", "two"]);
        }

        const sent = await kit.claudeTool<{ sentTo: string; identity: string; messageId: number }>(a, "send_message", { message: "from a", meetingId });
        expect(sent.payload.result).toMatchObject({ sentTo: "meeting", identity: "session", messageId: expect.any(Number) });
        const forB = (await kit.claudeTool<Read>(b, "read_messages", { meetingId })).payload.result!;
        expect(forB.messages).toEqual([expect.objectContaining({ text: "from a", from: `claude:${a}`, senderName: expect.any(String), senderMachine: "box-a · WSL Ubuntu_26" })]);
        expect((await kit.claudeTool<Read>(a, "read_messages", { meetingId })).payload.result!.messages).toEqual([]);

        const meeting = (await listed()).meetings.find((m) => m.id === meetingId)!;
        expect(meeting.participants).toEqual(["ide-a", `claude:${a}`]);
        await host.callTool("end_meeting", { meetingId }, "ide-a");
    });

    it("wakes the active members of a meeting with its news, and tells them when it ends", async () => {
        const s = ids();
        const [a, b] = [s("a"), s("b")];
        for (const id of [a, b]) await kit.hook("claude", "SessionStart", id);
        // a starts the meeting (joining it as an active member) and ends its turn.
        const meetingId = (await kit.claudeTool<{ meetingId: string }>(a, "start_meeting", { topic: "Wake test" })).payload.result!.meetingId;
        await kit.hook("claude", "Stop", a, { stop_hook_active: false });
        const waiting = kit.openHook("claude", BACKGROUND_WAIT_EVENT, a);
        await until(async () => (await kit.status(`claude:${a}`)) === "listening");

        const joined = await kit.claudeTool<{ delivery: string }>(b, "join_meeting", { meetingId });
        expect(joined.payload.result!.delivery).toBe("wake");
        await kit.claudeTool(b, "send_message", { meetingId, message: "a point" });
        const wake = (await waiting.response).payload.output?.wake ?? "";
        expect(wake).toContain(`Meeting "Wake test" (${meetingId}): 1 new message(s), #1–#1:\n--- Meeting message #1 from `);
        expect(wake).toContain("\na point\n--- End of meeting message #1 ---");
        expect(wake).not.toContain("Automatic turn");

        await kit.claudeTool(a, "end_meeting", { meetingId, summary: "settled" });
        expect(await kit.hook("claude", "Stop", a, { stop_hook_active: false })).toBeNull(); // who ended it is not told
        expect(context(await kit.hook("claude", "UserPromptSubmit", b))).toContain(`Meeting "Wake test" (${meetingId}) has ended: settled. No reply needed.`);
    });

    it("closes a meeting by consensus when every required approver endorses the draft", async () => {
        const s = ids();
        const [a, b] = [s("a"), s("b")];
        for (const id of [a, b]) await kit.hook("claude", "SessionStart", id);
        const meetingId = (await kit.claudeTool<{ meetingId: string }>(a, "start_meeting", { topic: "Consensus" })).payload.result!.meetingId;
        await kit.claudeTool(b, "join_meeting", { meetingId });

        const draft = await kit.claudeTool<{ currentProposalId: number }>(a, "send_message", { meetingId, message: "ship it", draft: true });
        expect(draft.status, draft.body).toBe(200);
        const messageId = draft.payload.result!.currentProposalId;
        expect(messageId).toBe(1);

        type Stance = { counted: boolean; decided: boolean; approvals: { required: string[]; waiting: string[] } };
        const first = await kit.claudeTool<Stance>(a, "stance", { meetingId, messageId, stance: "endorse" });
        expect(first.payload.result).toMatchObject({ counted: true, decided: false, approvals: { required: [`claude:${a}`, `claude:${b}`], waiting: [`claude:${b}`] } });
        // b reads the draft before taking a stance on it.
        await kit.claudeTool(b, "read_messages", { meetingId });
        const last = await kit.claudeTool<Stance>(b, "stance", { meetingId, messageId, stance: "endorse" });
        expect(last.payload.result).toMatchObject({ counted: true, decided: true });

        type Meeting = { id: string; status: string; endReason: string | null; decisionCount: number; proposal: { messageId: number; endorsed: string[] } };
        const meeting = (await listed()).meetings.find((m) => m.id === meetingId) as unknown as Meeting;
        expect(meeting).toMatchObject({ status: "closed", endReason: "consensus", decisionCount: 1, proposal: { messageId: 1 } });
        // The other approver learns how it ended from the closing notice.
        expect(context(await kit.hook("claude", "UserPromptSubmit", a))).toContain("decided by consensus on draft #1");
        expect([...meeting.proposal.endorsed].sort()).toEqual([`claude:${a}`, `claude:${b}`].sort());
        const read = await host.callTool<{ messages: { from: string; category: string; text: string }[] }>("read_messages", { meetingId, latest: true, count: 1 });
        expect(read.payload.result!.messages[0]).toMatchObject({ from: "n2n-nexus", category: "DECISION", text: expect.stringContaining("ship it") });
    });

    it("lets the user's seat decide drafts and end the meeting; others only propose the end", async () => {
        const s = ids();
        const [a, b] = [s("a"), s("b")];
        for (const id of [a, b]) await kit.hook("claude", "SessionStart", id);
        const meetingId = (await kit.claudeTool<{ meetingId: string }>(a, "start_meeting", { topic: "Seat", seat: "user" })).payload.result!.meetingId;
        await kit.claudeTool(b, "join_meeting", { meetingId, since: "beginning" });
        await kit.claudeTool(b, "read_messages", { meetingId });
        const draft = (await kit.claudeTool<{ currentProposalId: number }>(b, "send_message", { meetingId, message: "Decision point 1/1: plan", draft: true })).payload.result!.currentProposalId;

        await kit.claudeTool(a, "read_messages", { meetingId });
        type Stance = { decided: boolean; decisionId?: number; currentProposalId: number | null; approvals: { seat: { id: string; stance: string | null } | null } };
        const approved = await kit.claudeTool<Stance>(a, "stance", { meetingId, messageId: draft, stance: "endorse", note: "go" });
        expect(approved.payload.result).toMatchObject({ decided: false, decisionId: expect.any(Number), currentProposalId: null,
            approvals: { seat: { id: `claude:${a}`, stance: "endorse" } } });
        type Meeting = { id: string; status: string; seat: string | null; decisionCount: number; proposal: unknown };
        let meeting = (await listed()).meetings.find((m) => m.id === meetingId) as unknown as Meeting;
        expect(meeting).toMatchObject({ status: "active", seat: `claude:${a}`, decisionCount: 1, proposal: null });

        const proposed = await kit.claudeTool<{ ok: boolean; refused: boolean; status: string; messageId: number }>(b, "end_meeting", { meetingId, summary: "done" });
        expect(proposed.payload.result).toMatchObject({ ok: false, refused: true, status: "active", messageId: expect.any(Number) });
        expect((await kit.claudeTool(a, "end_meeting", { meetingId })).status).toBe(400);
        expect((await kit.claudeTool(a, "end_meeting", { meetingId, summary: "decided point 1" })).payload.result).toMatchObject({ ok: true, status: "closed" });
        meeting = (await listed()).meetings.find((m) => m.id === meetingId) as unknown as Meeting;
        expect(meeting.status).toBe("closed");
    });
});

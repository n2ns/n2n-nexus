// Meetings with the user's seat, black-box: the seat moves and the old seat stays a member;
// the AI consensus is told only when it changes; objections need grounds, a stance changes
// at most twice, withdraw counts nothing and the seat's veto is exempt; meeting notifications
// carry the texts (cut to notifyTextChars) and PostToolUse does not count as reading; a seat
// whose session was cleaned up keeps its rules until another session takes it.
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_WAIT_EVENT, agentKit, context, ids, nameOf } from "./agents.js";
import { HOOK, until, useHost } from "./harness.js";

const DAY = 24 * 60 * 60 * 1000;
const fmt = (text: string, ...args: (string | number)[]) => args.reduce<string>((t, a) => t.replace(/%[sd]/, String(a)), text);
const label = (session: string) => `${nameOf("codex", "proj", session)} (codex:${session})`;

type Result = Record<string, unknown>;
type Message = { id: number; from: string; text: string; category: string | null };
type Listing = { meetings: { id: string; status: string; seat: string | null; proposal: { messageId: number } | null; members: { id: string; mode: string }[] }[] };

describe("meetings with the user's seat", () => {
    const host = useHost({ rateLimit: 0, meetingRetentionDays: 2, retentionDays: 1 });
    const kit = agentKit(host);
    afterEach(() => kit.endSessions());

    /** A tool call as a Codex session that must succeed and not be refused. */
    async function ok(session: string, tool: string, args: Record<string, unknown> = {}): Promise<Result> {
        const res = await kit.codexTool<Result>(session, tool, args);
        expect(res.status, `${tool}: ${res.body}`).toBe(200);
        expect(res.payload.result?.refused, `${tool} refused: ${res.body}`).toBeUndefined();
        return res.payload.result!;
    }
    /** A tool call as a Codex session that the host rejects with a 400 saying `want`. */
    async function fails(session: string, want: string, tool: string, args: Record<string, unknown>) {
        const res = await kit.codexTool(session, tool, args);
        expect(res.status, `${tool}: ${res.body}`).toBe(400);
        expect(res.payload.error).toContain(want);
    }
    const catchUp = (session: string, meetingId: string) => ok(session, "read_messages", { meetingId, count: 50 });
    const stance = (session: string, meetingId: string, messageId: number, s: string, note = "") =>
        ok(session, "stance", { meetingId, messageId, stance: s, ...(note ? { note } : {}) });
    const draftOf = async (session: string, meetingId: string, message: string) => {
        await catchUp(session, meetingId);
        return (await ok(session, "send_message", { meetingId, message, draft: true })).currentProposalId as number;
    };
    const last = async (meetingId: string): Promise<Message> =>
        ((await host.callTool<{ messages: Message[] }>("read_messages", { meetingId, latest: true, count: 1 }, "observer")).payload.result!.messages[0]);
    const count = async (meetingId: string, text: string) =>
        (await host.callTool<{ messages: Message[] }>("read_messages", { meetingId, afterId: 0, count: 200 }, "observer")).payload.result!.messages.filter((m) => m.text === text).length;
    const listed = async (meetingId: string) =>
        (await host.callTool<Listing>("list_meetings", {}, "observer")).payload.result!.meetings.find((m) => m.id === meetingId)!;

    async function seated(s: (name: string) => string, members: string[]) {
        for (const name of ["a", ...members]) await kit.hook("codex", "SessionStart", s(name));
        const meetingId = (await ok(s("a"), "start_meeting", { topic: "Seated", seat: "user" })).meetingId as string;
        for (const name of members) await ok(s(name), "join_meeting", { meetingId, since: "beginning" });
        return meetingId;
    }

    it("the seat moves to whoever takes it last; the old seat stays an ordinary member", async () => {
        const s = ids();
        const meetingId = await seated(s, ["b"]);
        expect((await last(meetingId)).text).toBe(fmt(HOOK.texts.seatTaken, label(s("a"))));
        expect((await listed(meetingId)).seat).toBe(`codex:${s("a")}`);

        await ok(s("b"), "join_meeting", { meetingId, seat: "user" });
        expect(await last(meetingId)).toMatchObject({ from: "n2n-nexus", text: fmt(HOOK.texts.seatMoved, label(s("a")), label(s("b"))) });
        const meeting = await listed(meetingId);
        expect(meeting.seat).toBe(`codex:${s("b")}`);
        expect(meeting.members.map((m) => [m.id, m.mode])).toEqual([[`codex:${s("a")}`, "active"], [`codex:${s("b")}`, "active"]]);
        // The seat's messages name it as the seat.
        await catchUp(s("b"), meetingId);
        await ok(s("b"), "send_message", { meetingId, message: "as the user" });
        const seatName = fmt(HOOK.texts.seatSender, nameOf("codex", "proj", s("b")));
        expect((await host.callTool<{ messages: { senderName: string }[] }>("read_messages", { meetingId, latest: true, count: 1 }, "observer")).payload.result!.messages[0].senderName).toBe(seatName);
        await ok(s("b"), "end_meeting", { meetingId, summary: "decided: nothing; open: none; next: nobody" });
    });

    it("tells the AI consensus only when it changes; grounds, the change limit, withdraw and the seat's veto", async () => {
        const s = ids();
        const meetingId = await seated(s, ["b", "c"]);
        const draft = await draftOf(s("b"), meetingId, "Decision point 1/2: plan A");
        await catchUp(s("c"), meetingId);
        await stance(s("c"), meetingId, draft, "endorse");
        await stance(s("b"), meetingId, draft, "endorse");
        const consensus = fmt(HOOK.texts.aiConsensus, draft, `codex:${s("b")}, codex:${s("c")}`);
        expect((await last(meetingId)).text).toBe(consensus);
        expect((await listed(meetingId)).status).toBe("active"); // consensus decides nothing with a seat

        // Endorsing again changes no state: no second notice. Withdrawing one loses it; endorsing again restores it.
        await catchUp(s("b"), meetingId);
        await stance(s("b"), meetingId, draft, "endorse", "still");
        expect(await count(meetingId, consensus)).toBe(1);
        await catchUp(s("c"), meetingId);
        await stance(s("c"), meetingId, draft, "withdraw");
        expect((await last(meetingId)).text).toBe(fmt(HOOK.texts.aiConsensusLost, draft));
        await catchUp(s("c"), meetingId);
        await stance(s("c"), meetingId, draft, "endorse");
        expect(await count(meetingId, consensus)).toBe(2);

        // An objection needs grounds the host can check the form of; a stance changes at most twice.
        await catchUp(s("c"), meetingId);
        await fails(s("c"), "needs its grounds", "stance", { meetingId, messageId: draft, stance: "object", note: "no" });
        await fails(s("c"), "are not messages of this meeting", "stance", { meetingId, messageId: draft, stance: "object", note: "see #99" });
        await stance(s("c"), meetingId, draft, "object", `see #${draft}`); // change 1
        await catchUp(s("c"), meetingId);
        await stance(s("c"), meetingId, draft, "endorse", `answered in #${draft}`); // change 2
        await catchUp(s("c"), meetingId);
        await fails(s("c"), "is fixed after 2 changes", "stance", { meetingId, messageId: draft, stance: "object", note: `#${draft}` });
        await stance(s("c"), meetingId, draft, "withdraw"); // never locked, counts nothing
        await catchUp(s("c"), meetingId);
        await fails(s("c"), "is fixed after 2 changes", "stance", { meetingId, messageId: draft, stance: "object", note: `#${draft}` });
        await stance(s("c"), meetingId, draft, "endorse", `as before, #${draft}`); // the stance it had: not a change

        // The seat's veto needs no grounds and is not held back by unread messages; the draft is void.
        await catchUp(s("b"), meetingId);
        await ok(s("b"), "send_message", { meetingId, message: "unread for the seat" });
        const veto = await ok(s("a"), "stance", { meetingId, messageId: draft, stance: "object", note: "not now" });
        expect(veto).toMatchObject({ ok: true, currentProposalId: null });
        expect(Array.isArray(veto.unread) && (veto.unread as unknown[]).length > 0).toBe(true);
        expect((await last(meetingId)).text).toBe(fmt(HOOK.texts.seatVeto, draft, label(s("a")), "not now"));
        expect((await listed(meetingId)).proposal).toBeNull();
        await catchUp(s("a"), meetingId);
        await ok(s("a"), "end_meeting", { meetingId, summary: "decided: none; open: point 1; next: b redrafts" });
    });

    it("meeting notifications carry the texts, cut at notifyTextChars; PostToolUse does not count as reading, Stop does", async () => {
        const s = ids();
        const [chair, reader, writer] = [s("chair"), s("reader"), s("writer")];
        for (const id of [chair, reader, writer]) await kit.hook("claude", "SessionStart", id);
        const meetingId = (await kit.claudeTool<{ meetingId: string }>(chair, "start_meeting", { topic: "Texts" })).payload.result!.meetingId;
        await kit.hook("claude", "Stop", chair, { stop_hook_active: false });
        const waiting = kit.openHook("claude", BACKGROUND_WAIT_EVENT, chair);
        await until(async () => (await kit.status(`claude:${chair}`)) === "listening");
        await kit.claudeTool(reader, "join_meeting", { meetingId });
        await kit.claudeTool(writer, "join_meeting", { meetingId, mode: "async" });

        const long = "x".repeat(HOOK.limits.notifyTextChars + 50);
        await kit.claudeTool(writer, "send_message", { meetingId, message: long });
        const wake = (await waiting.response).payload.output?.wake ?? "";
        expect(wake).toContain(`Meeting "Texts" (${meetingId}): 1 new message(s), #1–#1:`);
        expect(wake).toContain("x".repeat(HOOK.limits.notifyTextChars));
        expect(wake).not.toContain(long);
        expect(wake).toContain(fmt(HOOK.texts.messageCut, HOOK.limits.notifyTextChars, long.length));
        expect(wake).toContain(HOOK.texts.meetingReadRest);
        // Cut: not read. The chair still finds it unread.
        const unreadForChair = await kit.claudeTool<{ messages: Message[] }>(chair, "read_messages", { meetingId });
        expect(unreadForChair.payload.result!.messages.map((m) => m.id)).toEqual([1]);

        // The reader gets the next message whole at PostToolUse: told, but not read; at Stop: read.
        await kit.claudeTool(reader, "read_messages", { meetingId }); // #1 read
        await kit.claudeTool(writer, "send_message", { meetingId, message: "short" });
        const told = context(await kit.hook("claude", "PostToolUse", reader, { tool_use_id: "t-x", tool_name: "Bash" }));
        expect(told).toContain("--- Meeting message #2 from ");
        expect(told).toContain("\nshort\n--- End of meeting message #2 ---");
        const stillUnread = await kit.claudeTool<{ messages: Message[] }>(reader, "read_messages", { meetingId, latest: true, count: 1 });
        expect(stillUnread.payload.result!.messages[0].id).toBe(2);
        // Read, then told the next one at Stop: that one counts as read (nothing before it is unread).
        await kit.claudeTool(reader, "read_messages", { meetingId });
        await kit.claudeTool(writer, "send_message", { meetingId, message: "third" });
        const stop = await kit.hook("claude", "Stop", reader, { stop_hook_active: false });
        expect(stop?.decision).toBe("block");
        expect(stop?.reason).toContain("\nthird\n--- End of meeting message #3 ---");
        const afterStop = await kit.claudeTool<{ messages: Message[] }>(reader, "read_messages", { meetingId });
        expect(afterStop.payload.result!.messages).toEqual([]);
        await kit.claudeTool(chair, "end_meeting", { meetingId, summary: "done" });
    });

    it("keeps the seat's rules after the seat's session was cleaned up; another session takes it", async () => {
        const s = ids();
        const t0 = Date.now() + 100 * DAY;
        await host.setClock(t0);
        const meetingId = await seated(s, ["b"]);
        const draft = await draftOf(s("b"), meetingId, "Decision point 1/1: plan");
        await kit.hook("codex", "SessionEnd", s("a"));
        await host.setClock(t0 + DAY + 1);
        const cleaned = await host.callTool<{ cleanup: { sessions: { id: string }[] } }>("host_maintenance", { action: "cleanup" }, "admin");
        expect(cleaned.payload.result!.cleanup.sessions.map((x) => x.id)).toContain(`codex:${s("a")}`);

        expect((await listed(meetingId)).seat).toBe(`codex:${s("a")}`);
        const refused = await kit.codexTool<Result>(s("b"), "end_meeting", { meetingId, summary: "done" });
        expect(refused.payload.result).toMatchObject({ ok: false, refused: true, status: "active" });

        await kit.hook("codex", "SessionStart", s("d"));
        await ok(s("d"), "join_meeting", { meetingId, seat: "user", since: "beginning" });
        expect((await last(meetingId)).text).toBe(fmt(HOOK.texts.seatMoved, label(s("a")), label(s("d"))));
        await catchUp(s("d"), meetingId);
        const decided = await stance(s("d"), meetingId, draft, "endorse", "go");
        expect(typeof decided.decisionId).toBe("number");
        expect((await last(meetingId)).category).toBe("DECISION");
        await catchUp(s("d"), meetingId);
        await ok(s("d"), "end_meeting", { meetingId, summary: "decided: point 1; open: none; next: nobody" });
    });
});

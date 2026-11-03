// Direct-message tools (peers, send, read, reply, broadcast, listen, set_profile) through POST /api/tools/call.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK, useHost, type Caller } from "./harness.js";
import { NO_AGENT_SESSION_ERROR, agentKit, context, ids, nameOf, type HookClient, type Profile } from "./agents.js";

type Sent = { messageId: string; to: { id: string; name: string; status: string } };
type Read = {
    messages: { messageId: string; from: { id: string; name: string }; replyTo: string | null; text: string; createdAt: string; expectsReply: boolean; broadcastId: string | null }[];
    remaining: number;
};

const host = useHost({ listenWaitMs: 300, rateLimit: 0 });
const kit = agentKit(host);
afterEach(() => kit.endSessions());

const hook = (client: HookClient, event: string, sessionId: string, cwd = "/work/proj") => kit.hook(client, event, sessionId, { cwd });
const callAs = <T>(caller: unknown, tool: string, args: Record<string, unknown> = {}) =>
    host.request<{ ok: boolean; result?: T; error?: string }>("POST", "/api/tools/call", { tool, args, instanceId: "i", ...(caller === undefined ? {} : { caller }) });
const codex = <T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) =>
    callAs<T>({ client: "codex", sessionId } satisfies Caller, tool, args);
const claude = <T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) => kit.claudeTool<T>(sessionId, tool, args);

const DM_TOOLS: [string, Record<string, unknown>][] = [
    ["peers", {}], ["send", { to: "x", text: "hi" }], ["read", {}], ["reply", { messageId: "m", text: "hi" }],
    ["listen", { on: true }], ["set_profile", { note: "n" }], ["broadcast", { text: "hi" }]
];

describe("direct-message tools: identity", () => {
    it("rejects all seven tools without a resolvable session and leaves other tools alone", async () => {
        const s = ids();
        await hook("claude", "SessionStart", s("known"));
        const noSession = { ok: false, error: NO_AGENT_SESSION_ERROR };
        for (const [tool, args] of DM_TOOLS) {
            for (const res of [
                await callAs(undefined, tool, args),                                           // other MCP clients
                await codex(s("missing"), tool, args),                                         // Codex without hooks
                await callAs({ client: "claude", toolUseId: `unbound_${s("x")}` }, tool, args)
            ]) {
                expect(res.status, tool).toBe(400);
                expect(res.payload, tool).toEqual(noSession);
            }
        }
        // A malformed caller names no session.
        for (const caller of [{ client: "claude" }, { client: "cursor", sessionId: "x" }]) {
            const res = await callAs(caller, "peers");
            expect(res.status).toBe(400);
            expect(res.payload).toEqual(noSession);
        }
        // Other tools ignore the caller, malformed or not.
        expect((await callAs(undefined, "list_meetings")).status).toBe(200);
        expect((await callAs({ client: "codex", sessionId: s("missing") }, "list_meetings")).status).toBe(200);
        expect((await callAs({ client: "cursor", sessionId: "x" }, "list_meetings")).status).toBe(200);
    });

    it("validates arguments", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("a"));
        expect((await codex(s("a"), "read", { count: 51 })).status).toBe(400);
        expect((await codex(s("a"), "send", { to: "x", text: "" })).status).toBe(400);
        expect((await codex(s("a"), "listen", {})).status).toBe(400);
        expect((await codex(s("a"), "listen", { on: false })).status).toBe(200);
    });
});

describe("direct-message tools: listen, set_profile", () => {
    it("listen returns the flag it set", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("a"));
        expect((await codex(s("a"), "listen", { on: true })).payload.result).toEqual({ listening: true });
        expect((await codex(s("a"), "listen", { on: false })).payload.result).toEqual({ listening: false });
    });

    it("set_profile validates, keeps names unique among sessions that are not offline and returns the profile", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("a"));
        await hook("codex", "SessionStart", s("b"));
        await hook("codex", "SessionStart", s("c"));
        await hook("codex", "SessionEnd", s("c"));

        expect((await codex(s("a"), "set_profile", {})).status).toBe(400);
        expect((await codex(s("a"), "set_profile", { name: "has space" })).status).toBe(400);
        expect((await codex(s("a"), "set_profile", { name: "x".repeat(49) })).status).toBe(400);
        expect((await codex(s("a"), "set_profile", { note: "n".repeat(HOOK.limits.maxNoteChars + 1) })).status).toBe(400);

        const taken = await codex(s("a"), "set_profile", { name: nameOf("codex", "proj", s("b")) });
        expect(taken.status).toBe(400);
        expect(taken.payload.error).toContain("already used");
        expect((await kit.profile(`codex:${s("a")}`))?.name).toBe(nameOf("codex", "proj", s("a")));

        // The offline session's name is free; the session's own current name is fine too.
        const renamed = await codex<{ profile: Profile }>(s("a"), "set_profile", { name: nameOf("codex", "proj", s("c")), note: "reviewing" });
        expect(renamed.payload.result?.profile).toMatchObject({ id: `codex:${s("a")}`, name: nameOf("codex", "proj", s("c")), note: "reviewing" });
        expect((await codex<{ profile: Profile }>(s("a"), "set_profile", { name: nameOf("codex", "proj", s("c")) })).status).toBe(200);
        const noteOnly = await codex<{ profile: Profile }>(s("a"), "set_profile", { note: "" });
        expect(noteOnly.payload.result?.profile).toMatchObject({ name: nameOf("codex", "proj", s("c")), note: "" });
    });

    it("set_profile title: the session's own title wins over the client's until it sets an empty one", async () => {
        const s = ids();
        await kit.hook("codex", "SessionStart", s("a"), { title: "From the client" });
        expect((await kit.profile(`codex:${s("a")}`))?.title).toBe("From the client");
        expect((await codex(s("a"), "set_profile", { title: "t".repeat(HOOK.limits.maxTitleChars + 1) })).status).toBe(400);

        const own = await codex<{ profile: Profile }>(s("a"), "set_profile", { title: "My own" });
        expect(own.payload.result?.profile).toMatchObject({ id: `codex:${s("a")}`, name: nameOf("codex", "proj", s("a")), title: "My own" });
        await kit.hook("codex", "UserPromptSubmit", s("a"), { title: "Renamed in the client" });
        await kit.hook("codex", "Stop", s("a"), { title: "Renamed in the client", stop_hook_active: false });
        expect((await kit.profile(`codex:${s("a")}`))?.title).toBe("My own");

        const cleared = await codex<{ profile: Profile }>(s("a"), "set_profile", { title: "" });
        expect(cleared.payload.result?.profile.title).toBe("");
        await kit.hook("codex", "UserPromptSubmit", s("a"), { title: "Renamed in the client" });
        expect((await kit.profile(`codex:${s("a")}`))?.title).toBe("Renamed in the client");
    });
});

describe("direct-message tools: send, reply, read", () => {
    it("send resolves `to` by id (any status) or by the name of a session that is not offline", async () => {
        const s = ids();
        await hook("claude", "SessionStart", s("a"), "/work/alpha");
        await hook("codex", "SessionStart", s("b"), "/work/beta");
        await hook("codex", "SessionStart", s("off"), "/work/off");
        await hook("codex", "SessionEnd", s("off"));

        const byName = await claude<Sent>(s("a"), "send", { to: nameOf("codex", "beta", s("b")), text: "by name" });
        expect(byName.status).toBe(200);
        expect(byName.payload.result).toEqual({ messageId: expect.any(String), to: { id: `codex:${s("b")}`, name: nameOf("codex", "beta", s("b")), status: "idle" } });

        const byId = await claude<Sent>(s("a"), "send", { to: `codex:${s("off")}`, text: "to offline" });
        expect(byId.payload.result?.to).toEqual({ id: `codex:${s("off")}`, name: nameOf("codex", "off", s("off")), status: "offline" });

        const offlineName = await claude(s("a"), "send", { to: nameOf("codex", "off", s("off")), text: "x" });
        expect(offlineName.status).toBe(400);
        expect(offlineName.payload.error).toContain("Unknown recipient");
        expect((await claude(s("a"), "send", { to: "nobody", text: "x" })).payload.error).toContain("Unknown recipient");

        const self = await claude(s("a"), "send", { to: nameOf("claude", "alpha", s("a")), text: "x" });
        expect(self.status).toBe(400);
        expect(self.payload.error).toContain("yourself");
        expect((await claude(s("a"), "send", { to: `claude:${s("a")}`, text: "x" })).status).toBe(400);

        // Offline recipients keep their messages and are told when they come back.
        await hook("codex", "SessionStart", s("off"), "/work/off");
        expect(JSON.stringify(await hook("codex", "UserPromptSubmit", s("off")))).toContain("to offline");
    });

    it("read returns unread messages oldest first in pages and marks them read", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        const sent: string[] = [];
        for (let i = 1; i <= 3; i++) sent.push((await codex<Sent>(s("s"), "send", { to: r, text: `m${i}` })).payload.result!.messageId);

        const first = await claude<Read>(s("r"), "read", { count: 2 });
        expect(first.payload.result).toEqual({
            messages: [
                { messageId: sent[0], from: { id: `codex:${s("s")}`, name: nameOf("codex", "proj", s("s")) }, replyTo: null, text: "m1", createdAt: expect.any(String), expectsReply: true, broadcastId: null },
                { messageId: sent[1], from: { id: `codex:${s("s")}`, name: nameOf("codex", "proj", s("s")) }, replyTo: null, text: "m2", createdAt: expect.any(String), expectsReply: true, broadcastId: null }
            ],
            remaining: 1
        });
        // Read messages are no longer announced; only the third one is.
        const fresh = JSON.stringify(await hook("claude", "PostToolUse", s("r")));
        expect(fresh).toContain("1 new direct message");
        expect(fresh).toContain("m3");
        expect(fresh).not.toContain("m1");

        const second = await claude<Read>(s("r"), "read");
        expect(second.payload.result?.messages.map((m) => m.text)).toEqual(["m3"]);
        expect(second.payload.result?.remaining).toBe(0);
        expect((await claude<Read>(s("r"), "read")).payload.result).toEqual({ messages: [], remaining: 0 });
        // Nothing unread is left to notify about.
        expect(await hook("claude", "UserPromptSubmit", s("r"))).toBeNull();
    });

    it("reply answers only messages sent to the caller, to the original sender, linked by replyTo", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await hook("claude", "SessionStart", s("other"));
        const original = (await codex<Sent>(s("s"), "send", { to: `claude:${s("r")}`, text: "question" })).payload.result!.messageId;

        const notMine = await claude(s("other"), "reply", { messageId: original, text: "x" });
        expect(notMine.status).toBe(400);
        expect(notMine.payload.error).toContain(`Message '${original}' not found or not sent to you; use a messageId from a notification or read.`);
        expect((await codex(s("s"), "reply", { messageId: original, text: "x" })).status).toBe(400);   // the sender cannot reply to its own message
        expect((await claude(s("r"), "reply", { messageId: "no-such", text: "x" })).status).toBe(400);

        await claude(s("r"), "read");                                                                   // read messages can still be answered
        const replied = await claude<Sent>(s("r"), "reply", { messageId: original, text: "answer" });
        expect(replied.payload.result?.to).toEqual({ id: `codex:${s("s")}`, name: nameOf("codex", "proj", s("s")), status: "idle" });

        const inbox = await codex<Read>(s("s"), "read");
        expect(inbox.payload.result?.messages).toEqual([
            { messageId: replied.payload.result!.messageId, from: { id: `claude:${s("r")}`, name: nameOf("claude", "proj", s("r")) }, replyTo: original, text: "answer", createdAt: expect.any(String), expectsReply: true, broadcastId: null }
        ]);
    });
});

describe("direct-message tools: broadcast", () => {
    type Broadcast = { broadcastId: string };

    it("goes to the sessions online now, the sender excepted, within project when given, also while a meeting is active", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"), "/work/bc");
        await hook("codex", "SessionStart", s("same"), "/work/bc/sub");
        await hook("claude", "SessionStart", s("other"), "/work/bcx");
        await hook("codex", "SessionStart", s("off"), "/work/bc");
        await hook("codex", "SessionEnd", s("off"));
        // An active meeting changes nothing for a broadcast.
        const meeting = (await codex<{ meetingId: string }>(s("s"), "start_meeting", { topic: "busy" })).payload.result!.meetingId;

        const sent = await codex<Broadcast>(s("s"), "broadcast", { text: "only /work/bc", project: "/work/bc" });
        expect(sent.status).toBe(200);
        expect(sent.payload.result).toEqual({ broadcastId: expect.any(String) });
        const id = sent.payload.result!.broadcastId;

        // In the project and online: announced at its next prompt, as a broadcast that needs no reply.
        const ctx = context(await hook("codex", "UserPromptSubmit", s("same")));
        expect(ctx).toContain(`${HOOK.texts.broadcastLine.replace("%s", id).replace("%s", HOOK.texts.broadcastToProject.replace("%s", "/work/bc"))}\nonly /work/bc\n`);
        expect(ctx).toContain(HOOK.texts.noReplyMark);
        // /work/bcx is not below /work/bc; the sender and the offline session get nothing, not even once it is back.
        expect(await hook("claude", "UserPromptSubmit", s("other"))).toBeNull();
        expect(await hook("codex", "UserPromptSubmit", s("s"))).toBeNull();
        await hook("codex", "SessionStart", s("off"), "/work/bc");
        expect(await hook("codex", "UserPromptSubmit", s("off"))).toBeNull();

        // Nobody online in the project: still sent, to nobody.
        expect((await codex<Broadcast>(s("s"), "broadcast", { text: "x", project: "/nowhere" })).payload.result).toEqual({ broadcastId: expect.any(String) });
        expect((await codex(s("s"), "end_meeting", { meetingId: meeting })).status).toBe(200);
    });

    it("does not hold an idle or working session's Stop, and a reply goes to the sender naming the broadcast", async () => {
        const s = ids();
        await hook("codex", "SessionStart", s("s"), "/work/bw");
        await hook("codex", "SessionStart", s("r"), "/work/bw");
        await codex(s("s"), "broadcast", { text: "can wait", project: "/work/bw" });
        expect(await kit.hook("codex", "Stop", s("r"), { stop_hook_active: false })).toBeNull();

        const asked = (await codex<Broadcast>(s("s"), "broadcast", { text: "who is free?", project: "/work/bw", expectsReply: true })).payload.result!.broadcastId;
        const inbox = (await codex<Read>(s("r"), "read")).payload.result!.messages;
        const copy = inbox.find((m) => m.text === "who is free?")!;
        expect(copy).toMatchObject({ broadcastId: asked, expectsReply: true, from: { id: `codex:${s("s")}` } });
        const replied = await codex<Sent>(s("r"), "reply", { messageId: copy.messageId, text: "me" });
        expect(replied.payload.result?.to.id).toBe(`codex:${s("s")}`);
        expect(context(await hook("codex", "UserPromptSubmit", s("s")))).toContain(`${HOOK.texts.messageReplyToBroadcast.replace("%s", asked)}\nme\n`);

        // wake is no argument of broadcast: it is dropped, and the Stop of a session that is not listening is not held.
        expect((await codex(s("s"), "broadcast", { text: "still waits", project: "/work/bw", wake: true })).status).toBe(200);
        expect(await kit.hook("codex", "Stop", s("r"), { stop_hook_active: false })).toBeNull();
    });
});

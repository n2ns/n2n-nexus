// POST /api/hook and tool calls of Antigravity conversations: their identity, the
// output shapes Antigravity reads, the title set once, the waiter reminder and
// the persistent waits of the waiter. The other clients' behavior is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK, until, useHost } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, SESSION_START_CLOSING, WAKE_RESULT_EVENT, agentKit, context, ids, injected } from "./agents.js";

const host = useHost({ listenWaitMs: 2000, rateLimit: 0 });
const { hook, openHook, antigravityTool, send, profile, status, endSessions } = agentKit(host);
afterEach(() => endSessions());
const REMINDER: string = HOOK.texts.waiterReminder;

describe("Antigravity conversations", () => {
    it("are sessions named by their conversation id, with injected steps and continue decisions", async () => {
        const s = ids();
        const a = `antigravity:${s("a")}`;
        const out = await hook("antigravity", "SessionStart", s("a"));
        expect(injected(out)).toContain(SESSION_START_CLOSING);
        expect(out?.hookSpecificOutput).toBeUndefined();
        expect(await profile(a)).toMatchObject({ client: "antigravity", status: "idle" });

        const peers = await antigravityTool<{ self: { id: string; client: string } }>(s("a"), "peers");
        expect(peers.status, peers.body).toBe(200);
        expect(peers.payload.result!.self).toMatchObject({ id: a, client: "antigravity" });
        const empty = await host.callTool("peers", {}, "i3", { client: "antigravity", sessionId: "" });
        expect(empty.status).not.toBe(200);

        await hook("codex", "SessionStart", s("s"));
        await hook("antigravity", "UserPromptSubmit", s("a"));
        await send(s("s"), a, "during the turn");
        const stop = await hook("antigravity", "Stop", s("a"), { stop_hook_active: false });
        expect(stop).toMatchObject({ decision: "continue" });
        expect(stop?.reason).toContain("during the turn");
        expect(await hook("antigravity", "Stop", s("a"), { stop_hook_active: true })).toBeNull();

        // A held listening Stop continues the same way.
        expect((await antigravityTool(s("a"), "listen", { on: true })).status).toBe(200);
        await hook("antigravity", "UserPromptSubmit", s("a"));
        const listening = openHook("antigravity", "Stop", s("a"), { stop_hook_active: false });
        await until(async () => (await status(a)) === "listening");
        await send(s("s"), a, "while listening");
        const held = (await listening.response).payload.output;
        expect(held).toMatchObject({ decision: "continue" });
        expect(held?.reason).toContain("while listening");

        // The other clients keep their shapes.
        await hook("codex", "UserPromptSubmit", s("c"));
        await send(s("s"), `codex:${s("c")}`, "to codex");
        expect(context(await hook("codex", "PostToolUse", s("c")))).toContain("to codex");
    });

    it("take the title of their first SessionStart once and remind when no waiter waits", async () => {
        const s = ids();
        const a = `antigravity:${s("a")}`;
        await hook("antigravity", "SessionStart", s("a"), { title: "first prompt" });
        await hook("antigravity", "SessionStart", s("a"), { title: "second prompt" });
        await hook("antigravity", "Stop", s("a"), { stop_hook_active: false, title: "a stop" });
        expect((await profile(a))?.title).toBe("first prompt");

        // Resumed without SessionStart: the first prompt says the waiter is not running.
        expect(injected(await hook("antigravity", "UserPromptSubmit", s("b")))).toContain(REMINDER);
        await hook("antigravity", "Stop", s("b"), { stop_hook_active: false });
        const waiting = openHook("antigravity", BACKGROUND_WAIT_EVENT, s("b"));
        await until(async () => (await status(`antigravity:${s("b")}`)) === "listening");
        expect(await hook("antigravity", "UserPromptSubmit", s("b"))).toBeNull();
        // The prompt did not end the wait: it is still open and wakes after the turn.
        await hook("codex", "SessionStart", s("s"));
        await hook("antigravity", "Stop", s("b"), { stop_hook_active: false });
        await send(s("s"), `antigravity:${s("b")}`, "after the turn");
        const wake = (await waiting.response).payload.output;
        expect(wake?.wake).toContain("after the turn");
        expect(await hook("antigravity", "UserPromptSubmit", s("b"))).toBeNull(); // the woken turn: no reminder
    });

    it("hand a wake to one of two waiters and deliver it again after a failed send", async () => {
        const s = ids();
        const a = `antigravity:${s("a")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("antigravity", "SessionStart", s("a"));
        const first = openHook("antigravity", BACKGROUND_WAIT_EVENT, s("a"));
        const second = openHook("antigravity", BACKGROUND_WAIT_EVENT, s("a"));
        await until(async () => (await status(a)) === "listening");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await send(s("s"), a, "once");
        const outs = await Promise.all([first.response, second.response]).then((rs) => rs.map((r) => r.payload.output));
        const wakes = outs.filter((o) => o?.wake);
        expect(wakes).toHaveLength(1);
        expect(outs.filter((o) => o?.timeout)).toHaveLength(1);

        expect(await hook("antigravity", WAKE_RESULT_EVENT, s("a"), { dispatch_id: wakes[0]!.dispatchId, ok: false })).toBeNull();
        const again = openHook("antigravity", BACKGROUND_WAIT_EVENT, s("a"));
        expect((await again.response).payload.output?.wake).toContain("once");
    });
});

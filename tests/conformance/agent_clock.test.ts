// Time-dependent agent-session behaviour, driven by POST /test/clock (test build only).
// Each test pins the clock to its own base, ten days after the previous one, so
// sessions and messages of earlier tests are far outside every time window.
import { afterEach, describe, expect, it } from "vitest";
import { HOOK, until, useHost, type Caller } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, NOTICE_PREFIX, NO_AGENT_SESSION_ERROR, agentKit, context, ids, type Profile } from "./agents.js";

const { staleSessionMs: STALE_SESSION_MS, peerWindowMs: PEER_WINDOW_MS, idleSubscriptionTtlMs: IDLE_SUBSCRIPTION_TTL_MS,
    messageTtlMs: MESSAGE_TTL_MS, toolUseBindingTtlMs: TOOL_USE_BINDING_TTL_MS } = HOOK.timing;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("agent sessions over time", () => {
    const host = useHost({ listenWaitMs: 1000, rateLimit: 0 });
    const { hook, openHook, claudeTool, codexTool, send, sessions, profile, status, endSessions } = agentKit(host);
    afterEach(() => endSessions());

    let base = Date.now();
    const nextBase = () => (base += 10 * DAY);

    it("refreshes last activity on every hook event and direct-message tool call", async () => {
        const s = ids();
        const a = `claude:${s("a")}`;
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("claude", "SessionStart", s("a"));
        expect((await profile(a))?.lastActiveAt).toBe(iso(t0));
        await host.setClock(t0 + 5000);
        await hook("claude", "PreToolUse", s("a"), { tool_use_id: `toolu_x_${s("a")}` });
        expect((await profile(a))?.lastActiveAt).toBe(iso(t0 + 5000));
        expect(await status(a)).toBe("idle");

        await hook("codex", "SessionStart", s("b"));
        await host.setClock(t0 + 65_000);
        expect((await codexTool(s("b"), "listen", { on: false })).status).toBe(200);
        expect((await profile(`codex:${s("b")}`))?.lastActiveAt).toBe(iso(t0 + 65_000));
    });

    it("counts idle and working sessions without activity for STALE_SESSION_MS as offline until they are active again", async () => {
        const s = ids();
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("codex", "SessionStart", s("idle"));
        await hook("codex", "UserPromptSubmit", s("busy"));
        await hook("codex", "SessionStart", s("waiting"));
        expect((await codexTool(s("waiting"), "listen", { on: true })).status).toBe(200);
        const waiting = openHook("codex", "Stop", s("waiting"));                // a Stop hook is waiting for messages
        await until(async () => (await status(`codex:${s("waiting")}`)) === "listening");

        await host.setClock(t0 + STALE_SESSION_MS + 1000);
        const text = context(await hook("claude", "SessionStart", s("new")));
        expect(await status(`codex:${s("idle")}`)).toBe("offline");
        expect(await status(`codex:${s("busy")}`)).toBe("offline");
        expect(await status(`codex:${s("waiting")}`)).toBe("listening");
        expect(text).toContain("1 other AI session is online:");
        expect(text).toContain(`(codex:${s("waiting")})`);

        // Any event brings a session back, a direct-message tool call or Claude's PreToolUse included.
        await hook("codex", "UserPromptSubmit", s("idle"));
        expect(await status(`codex:${s("idle")}`)).toBe("working");
        const peers = await codexTool<{ self: { status: string } }>(s("busy"), "peers");
        expect(peers.payload.result?.self.status).toBe("working");
        await hook("claude", "SessionStart", s("quiet"));
        await host.setClock(t0 + 2 * STALE_SESSION_MS + 2000);
        await hook("codex", "UserPromptSubmit", s("idle"));                     // expires claude:quiet
        expect(await status(`claude:${s("quiet")}`)).toBe("offline");
        await hook("claude", "PreToolUse", s("quiet"), { tool_use_id: `toolu_quiet_${s("quiet")}` });
        expect(await status(`claude:${s("quiet")}`)).toBe("working");
        expect((await waiting.response).payload.output).toBeNull();             // the listening wait ran out
    });

    it("counts a background wait as activity, so the session does not go stale between two waits", async () => {
        const s = ids();
        const r = `codex:${s("r")}`;
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("codex", "SessionStart", s("r"));
        await hook("codex", "Stop", s("r"), { stop_hook_active: false });

        await host.setClock(t0 + STALE_SESSION_MS + 1000);
        const background = openHook("codex", BACKGROUND_WAIT_EVENT, s("r"));
        expect((await background.response).payload.output).toEqual({ timeout: true });
        expect(await status(r)).toBe("idle");
        await hook("claude", "SessionStart", s("other"));                       // any event expires stale sessions before the next wait
        expect(await status(r)).toBe("idle");
    });

    it("drops idle subscriptions older than IDLE_SUBSCRIPTION_TTL_MS without a notice", async () => {
        const s = ids();
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("codex", "SessionStart", s("w"));
        await hook("codex", "SessionStart", s("t"));
        await send(s("w"), `codex:${s("t")}`, "task", true);
        await codexTool(s("t"), "read");
        await host.setClock(t0 + IDLE_SUBSCRIPTION_TTL_MS + 1000);
        await hook("codex", "Stop", s("t"));
        expect(await hook("codex", "UserPromptSubmit", s("w"))).toBeNull();
    });

    it("expires unread messages after MESSAGE_TTL_MS and tells the sender", async () => {
        const s = ids();
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await send(s("s"), `claude:${s("r")}`, "stale request\nmore");
        await host.setClock(t0 + MESSAGE_TTL_MS + 1000);

        await hook("codex", "SessionStart", s("other"));                        // any hook runs the expiry check
        expect(context(await hook("codex", "UserPromptSubmit", s("s"))))
            .toBe(`${NOTICE_PREFIX} Notices:\n- Your message to claude@proj (claude:${s("r")}) expired unread: "stale request"`);
        expect(await hook("claude", "UserPromptSubmit", s("r"))).toBeNull();
        expect((await claudeTool<{ messages: unknown[] }>(s("r"), "read")).payload.result?.messages).toEqual([]);
    });

    it("resolves a Claude tool call through the PreToolUse binding until it expires", async () => {
        const s = ids();
        const t0 = nextBase();
        await host.setClock(t0);
        await hook("claude", "SessionStart", s("a"));
        const toolUseId = `toolu_1_${s("a")}`;
        expect(await hook("claude", "PreToolUse", s("a"), { tool_use_id: toolUseId })).toBeNull();
        const caller: Caller = { client: "claude", toolUseId };
        expect((await host.callTool<{ self: { id: string } }>("peers", {}, null, caller)).payload.result?.self.id).toBe(`claude:${s("a")}`);

        await host.setClock(t0 + TOOL_USE_BINDING_TTL_MS + 1000);
        const expired = await host.callTool("peers", {}, null, caller);
        expect(expired.status).toBe(400);
        expect(expired.payload).toEqual({ ok: false, error: NO_AGENT_SESSION_ERROR });
    });

    it("peers returns self and the sessions not offline; includeOffline adds those active within PEER_WINDOW_MS; most recent first", async () => {
        const s = ids();
        const t0 = nextBase();
        await host.setClock(t0 - PEER_WINDOW_MS - 60_000);
        await hook("codex", "SessionStart", s("gone"), { cwd: "/work/old" });
        await hook("codex", "SessionEnd", s("gone"));
        await hook("codex", "SessionStart", s("stale"), { cwd: "/work/stale" }); // never ended, but stale: offline and too old to list
        await host.setClock(t0 - 2000);
        await hook("claude", "SessionStart", s("recent-offline"));
        await hook("claude", "SessionEnd", s("recent-offline"));
        await host.setClock(t0 - 1000);
        await hook("claude", "SessionStart", s("me"), { cwd: "/work/mine" });
        await hook("codex", "UserPromptSubmit", s("busy"));
        await host.setClock(t0);

        const { payload } = await claudeTool<{ self: Profile; peers: Profile[] }>(s("me"), "peers");
        expect(payload.result?.self).toEqual({
            id: `claude:${s("me")}`, name: "claude@mine", title: "", client: "claude", cwd: "/work/mine", hostname: "box", platform: "linux", utcOffset: 0, label: "",
            note: "", status: "idle", lastActiveAt: iso(t0)
        });
        expect(payload.result?.peers.map((p) => [p.id, p.status])).toEqual([[`codex:${s("busy")}`, "working"]]);

        const all = await claudeTool<{ self: Profile; peers: Profile[] }>(s("me"), "peers", { includeOffline: true });
        expect(all.payload.result?.peers.map((p) => [p.id, p.status])).toEqual([
            [`codex:${s("busy")}`, "working"], [`claude:${s("recent-offline")}`, "offline"]
        ]);
        expect(Object.keys(payload.result!.peers[0]).sort()).toEqual(["client", "cwd", "hostname", "id", "label", "lastActiveAt", "name", "note", "platform", "status", "title", "utcOffset"]);
        expect((await sessions()).map((p) => p.id)).not.toContain(`codex:${s("stale")}`);
    });
});

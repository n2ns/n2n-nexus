import { afterEach, describe, expect, it } from "vitest";
import { HOOK, until, useHost } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, agentKit, context, ids } from "./agents.js";

describe("session activity across host restarts", () => {
    const host = useHost({ listenWaitMs: 10_000, rateLimit: 0 });
    const { hook, openHook, send, sessions, status, endSessions } = agentKit(host);
    afterEach(() => endSessions());

    it("expires absent sessions from their original activity and lets surviving idle clients reconnect", async () => {
        const s = ids();
        await host.setClock(Date.now() - HOOK.timing.staleSessionMs - 60_000);
        for (const id of ["a", "b", "gone", "ended"]) {
            await hook("codex", "SessionStart", s(id));
        }
        await hook("claude", "UserPromptSubmit", s("working-gone"));
        await hook("codex", "SessionEnd", s("ended"));
        await hook("codex", "Stop", s("a"));
        await hook("codex", "Stop", s("b"));

        // Restart on the same database with the real clock, after the stale limit.
        await host.restart();
        const health = await host.request<{ sessions: { online: number } }>("GET", "/health");
        expect(health.status).toBe(200);
        expect(health.payload.sessions.online).toBe(0);
        expect(await sessions()).toEqual([]); // an unrelated caller expires all old sessions

        const first = openHook("codex", BACKGROUND_WAIT_EVENT, s("a"));
        await until(async () => await status(`codex:${s("a")}`) === "listening");
        // Expiry must remain distinguishable from SessionEnd across another restart.
        await host.restart();
        expect((await first.response).payload.output).toEqual({ timeout: true });
        const second = openHook("codex", BACKGROUND_WAIT_EVENT, s("b"));
        await until(async () => await status(`codex:${s("b")}`) === "listening");
        await hook("codex", "SessionStart", s("sender"));
        await send(s("sender"), `codex:${s("b")}`, "delivered after restart");
        expect((await second.response).payload.output?.dispatchId).toBeTruthy();
        expect(context(await hook("codex", "UserPromptSubmit", s("b")))).toContain("delivered after restart");

        expect(await status(`codex:${s("gone")}`)).toBe("offline");
        expect(await hook("codex", BACKGROUND_WAIT_EVENT, s("ended"))).toBeNull();
        expect(await hook("claude", BACKGROUND_WAIT_EVENT, s("working-gone"))).toBeNull();
        expect(await status(`codex:${s("ended")}`)).toBe("offline");
        expect(await status(`claude:${s("working-gone")}`)).toBe("offline");
    });
});

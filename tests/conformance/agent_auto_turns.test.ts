// Automatic turn limit with maxAutoTurns 2 (one host per setting: see agent_auto_turns_one / _unlimited).
import { afterEach, describe, expect, it } from "vitest";
import { until, useHost } from "./harness.js";
import { BACKGROUND_WAIT_EVENT, agentKit, context, ids, type HookClient } from "./agents.js";

const host = useHost({ listenWaitMs: 2000, maxAutoTurns: 2, rateLimit: 0 });
const { hook, openHook, claudeTool, codexTool, send, status, endSessions } = agentKit(host);
afterEach(() => endSessions());

describe("POST /api/hook: automatic turn limit", () => {
    /** The woken turn as the client runs it: its prompt, then the end of the turn. */
    async function wokenTurn(client: HookClient, sessionId: string) {
        await hook(client, "UserPromptSubmit", sessionId);
        await hook(client, "Stop", sessionId, { stop_hook_active: false });
    }

    it("wakes at most maxAutoTurns times until the user prompts; the woken turn's own prompt does not count", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });

        for (const n of [1, 2]) {
            const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
            await until(async () => (await status(r)) === "listening");
            await send(s("s"), r, `ping ${n}`);
            const wake = (await waiting.response).payload.output?.wake ?? "";
            expect(wake).toContain(`ping ${n}`);
            expect(wake).toContain(`Automatic turn ${n} of 2 since your user's last prompt; after turn 2, messages wait until your user prompts again.`);
            await claudeTool(s("r"), "read");
            await wokenTurn("claude", s("r"));
        }

        // The limit is reached: the wait still holds (meeting news would wake it), but the message only waits, unread and not announced.
        const third = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "ping 3");
        expect((await third.response).payload.output).toEqual({ timeout: true });
        expect(await status(r)).toBe("idle");

        // A real prompt (no wake just before it) starts counting again and announces the message.
        expect(context(await hook("claude", "UserPromptSubmit", s("r")))).toContain("ping 3");
        await claudeTool(s("r"), "read");
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });
        const again = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
        await until(async () => (await status(r)) === "listening");
        await send(s("s"), r, "ping 4");
        expect((await again.response).payload.output?.wake).toContain("Automatic turn 1 of 2");
    });

    it("meeting news wakes without counting as an automatic turn, and still wakes once the limit is reached", async () => {
        const s = ids();
        const r = `claude:${s("r")}`;
        await hook("codex", "SessionStart", s("s"));
        await hook("claude", "SessionStart", s("r"));
        const meetingId = (await claudeTool<{ meetingId: string }>(s("r"), "start_meeting", { topic: "Turns" })).payload.result!.meetingId;
        expect((await codexTool(s("s"), "join_meeting", { meetingId })).status).toBe(200);
        await hook("claude", "Stop", s("r"), { stop_hook_active: false });

        /** What wakes r's background wait once `arrive` has sent something. */
        const wokenBy = async (arrive: () => Promise<unknown>) => {
            const waiting = openHook("claude", BACKGROUND_WAIT_EVENT, s("r"));
            await until(async () => (await status(r)) === "listening");
            await arrive();
            return (await waiting.response).payload.output?.wake ?? "";
        };
        const say = async (message: string) => {
            const said = await codexTool<{ refused?: boolean }>(s("s"), "send_message", { meetingId, message });
            expect(said.status, said.body).toBe(200);
            expect(said.payload.result?.refused).toBeUndefined();
        };

        const news = await wokenBy(() => say("a point"));
        expect(news).toContain("\na point\n");
        expect(news).not.toContain("Automatic turn");
        await wokenTurn("claude", s("r"));

        // The meeting's wake used up neither of the two automatic turns.
        for (const n of [1, 2]) {
            const wake = await wokenBy(() => send(s("s"), r, `ping ${n}`));
            expect(wake).toContain(`Automatic turn ${n} of 2 since your user's last prompt`);
            await claudeTool(s("r"), "read");
            await wokenTurn("claude", s("r"));
        }

        // Past the limit a direct message only waits; meeting news still wakes, without the message.
        const past = await wokenBy(async () => {
            await send(s("s"), r, "ping 3");
            await say("another point");
        });
        expect(past).toContain("\nanother point\n");
        expect(past).not.toContain("ping 3");
        expect(past).not.toContain("Automatic turn");
        expect((await claudeTool(s("r"), "end_meeting", { meetingId, summary: "done" })).status).toBe(200);
    });
});

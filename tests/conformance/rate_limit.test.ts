// Rate limits: burst 3 per instance, 15 per address (5x). The refill rate is so low
// that no token comes back during a test, so the counts do not depend on machine speed.
// Each test restarts the host for fresh buckets.
import { beforeEach, describe, expect, it } from "vitest";
import { useHost } from "./harness.js";
import { TEST_MACHINE } from "./agents.js";

const BURST = 3;
const ADDRESS_BURST = BURST * 5;

const host = useHost({ rateLimit: 0.001, rateBurst: BURST });
beforeEach(() => host.restart());

const send = (instanceId: string) => host.callTool("send_message", { message: "x" }, instanceId);
const hook = (sessionId: string) => host.request("POST", "/api/hook", { client: "claude", input: { hook_event_name: "PostToolUse", session_id: sessionId, machine: TEST_MACHINE } });

describe("rate limiting", () => {
    it("answers 429 with Retry-After once an instance spends its burst, without affecting others", async () => {
        for (let i = 0; i < BURST; i++) expect((await send("busy")).status).toBe(200);
        const limited = await send("busy");
        expect(limited.status).toBe(429);
        expect(limited.payload.ok).toBe(false);
        expect(limited.payload.error).toContain("instance 'busy'");
        expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect((await send("calm")).status).toBe(200);
        // Health and the tool list are never limited.
        for (let i = 0; i < 20; i++) {
            expect((await host.request("GET", "/api/tools")).status).toBe(200);
            expect((await host.request("GET", "/health")).status).toBe(200);
        }
    });

    it("limits tool calls without an instance id only per address, not in a shared bucket", async () => {
        for (let i = 0; i < 10; i++) {
            const res = await host.callTool("list_meetings", {}, null);
            expect(res.status, `request ${i}: ${res.payload?.error}`).toBe(200);
        }
    });

    it("caps a client that rotates instance ids by its address", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < ADDRESS_BURST + 5; i++) statuses.push((await send(`rotating-${i}`)).status);
        expect(statuses.slice(0, ADDRESS_BURST).every((s) => s === 200)).toBe(true);
        expect(statuses.slice(ADDRESS_BURST).every((s) => s === 429)).toBe(true);
    });

    it("limits hooks per session, apart from tool calls and from other sessions", async () => {
        for (let i = 0; i < BURST; i++) expect((await send("busy")).status).toBe(200);
        expect((await send("busy")).status).toBe(429);                          // instance exhausted: hooks still run
        for (let i = 0; i < BURST; i++) expect((await hook("a")).status).toBe(200);
        const limited = await hook("a");
        expect(limited.status).toBe(429);                                       // session claude:a exhausted (8 of 15 address tokens)
        expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect((await hook("b")).status).toBe(200);                              // another session is not affected
    });
});

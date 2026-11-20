import { afterEach, expect, it } from "vitest";
import { agentKit, BACKGROUND_WAIT_EVENT, context, ids } from "./agents.js";
import { useHost } from "./harness.js";

const host = useHost({ listenWaitMs: 300, rateLimit: 0 });
const kit = agentKit(host);
afterEach(() => kit.endSessions());

it.each([false, true])("redelivers meeting news shown only to a tool in a continued turn unless read=%s", async (read) => {
    const s = ids();
    const receiver = s("receiver");
    await kit.hook("claude", "SessionStart", receiver);
    await kit.hook("claude", "UserPromptSubmit", receiver);
    const created = await host.callTool<{ meetingId: string }>("start_meeting", { topic: "continued turn" }, "sender");
    const meetingId = created.payload.result!.meetingId;
    try {
        expect((await kit.claudeTool(receiver, "join_meeting", { meetingId })).status).toBe(200);
        await host.callTool("send_message", { meetingId, message: "initial message" }, "sender");
        expect((await kit.hook("claude", "Stop", receiver, { stop_hook_active: false }))?.decision).toBe("block");
        for (const message of ["second message", "third message"]) {
            await host.callTool("send_message", { meetingId, message }, "sender");
            expect(context(await kit.hook("claude", "PostToolUse", receiver))).toContain(message);
        }
        if (read) expect((await kit.claudeTool(receiver, "read_messages", { meetingId })).status).toBe(200);
        expect(await kit.hook("claude", "Stop", receiver, { stop_hook_active: true })).toBeNull();
        const result = await kit.hook("claude", BACKGROUND_WAIT_EVENT, receiver);
        if (read) expect(result).toEqual({ timeout: true });
        else {
            expect(result?.wake).toContain("second message");
            expect(result?.wake).toContain("third message");
            expect(result?.wake).not.toContain("initial message");
        }
    } finally {
        await host.callTool("end_meeting", { meetingId }, "sender");
    }
});

// The pi extension under an automatic-turn limit: a run Stop continues is the same turn, not a
// prompt of the user's, so it does not reset the count of automatic turns.
import { describe, expect, it } from "vitest";

import { useHost, until } from "./conformance/harness.js";
import { agentKit, ids } from "./conformance/agents.js";
import { ctxOf, piKit } from "./helpers/pi.js";

const host = useHost({ listenWaitMs: 300, rateLimit: 0, maxAutoTurns: 3 });
const kit = agentKit(host);
const { started } = piKit(host, () => kit.endSessions(), "pi-extension-turns");

describe("pi extension, automatic turns", () => {
    it("counts the turns Stop continues and the wake after them, without a reset in between", async () => {
        const s = ids()("turns");
        const sender = ids()("sender");
        const pi = await started(s);
        await kit.hook("codex", "SessionStart", sender);
        const to = (await kit.profile(`pi:${s}`))!.name;

        await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s));
        await kit.send(sender, to, "one");
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        await until(() => pi.userMessages.length === 1);
        expect(pi.userMessages[0].text).toContain("Automatic turn 1 of 3");

        // pi starts the continued run with the message the extension sent.
        await pi.emit("before_agent_start", { messageType: "user", prompt: pi.userMessages[0].text }, ctxOf(s));
        await kit.send(sender, to, "two");
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        await until(() => pi.userMessages.length === 2, 5000);
        expect(pi.userMessages[1].text).toContain("two");
        expect(pi.userMessages[1].text).toContain("Automatic turn 2 of 3");
    });

    it("treats the prompt after an aborted continued run as the user's own", async () => {
        const s = ids()("abort-continued");
        const sender = ids()("sender");
        const pi = await started(s);
        await kit.hook("codex", "SessionStart", sender);
        const to = (await kit.profile(`pi:${s}`))!.name;
        await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s));
        await kit.send(sender, to, "one");
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        await until(() => pi.userMessages.length === 1);
        await pi.emit("before_agent_start", { messageType: "user", prompt: pi.userMessages[0].text }, ctxOf(s));
        await pi.emit("agent_settled", { aborted: true }, ctxOf(s));

        // The user's next prompt is announced what arrived meanwhile.
        await kit.send(sender, to, "after the abort");
        const prompt = await pi.emit("before_agent_start", { messageType: "user", prompt: "next" }, ctxOf(s)) as { message?: { content: string } } | undefined;
        expect(prompt?.message?.content).toContain("after the abort");
    });
});

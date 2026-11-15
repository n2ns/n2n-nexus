// The pi extension `n2n-nexus install pi` writes (src/cli/pi.ts), run against a real host: the
// session and its introduction, a direct message at the next prompt and during a run (Stop
// continues it), the background wait that wakes an idle pi session, and the session end.
// The extension's pi calls are faked; each hook is the built CLI (`hook pi`), as in pi.
import { describe, expect, it } from "vitest";

import { useHost, until } from "./conformance/harness.js";
import { NO_AGENT_SESSION_ERROR, agentKit, ids, nameOf } from "./conformance/agents.js";
import { ctxOf, piKit } from "./helpers/pi.js";
import { machineInfo } from "../src/cli/machine.js";

const host = useHost({ listenWaitMs: 300, rateLimit: 0 });
const kit = agentKit(host);
const { started, hooks } = piKit(host, () => kit.endSessions(), "pi-extension");

describe("pi extension", () => {
    it("registers the session at start and gives its introduction for the next prompt", async () => {
        const s = ids()("start");
        const pi = await started(s);
        expect(await kit.profile(`pi:${s}`)).toMatchObject({ client: "pi", cwd: "/work/proj", status: "idle" });
        expect(pi.customMessages).toHaveLength(1);
        expect(pi.customMessages[0].opts).toEqual({ deliverAs: "nextTurn" });
        expect(pi.customMessages[0].msg).toMatchObject({ customType: "n2n-nexus", display: false });
        expect(pi.customMessages[0].msg.content).toContain(nameOf("pi", "proj", s));
    });

    it("gives a message that waits at the prompt to the run, and a message during a run continues it at Stop", async () => {
        const s = ids()("prompt");
        const sender = ids()("sender");
        const pi = await started(s);
        await kit.hook("codex", "SessionStart", sender);
        const to = (await kit.profile(`pi:${s}`))!.name;

        // Waiting for the prompt: the run starts with the message as context.
        await kit.send(sender, to, "first note");
        const prompt = await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s)) as { message: { content: string } };
        expect(prompt.message).toMatchObject({ customType: "n2n-nexus", display: false });
        expect(prompt.message.content).toContain("first note");
        expect(await kit.status(`pi:${s}`)).toBe("working");

        // Arriving during the run: Stop holds the run open and continues it with the message.
        await kit.send(sender, to, "second note");
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        await until(() => pi.userMessages.length === 1);
        expect(pi.userMessages[0].text).toContain("second note");
        expect(pi.userMessages[0].opts).toEqual({ deliverAs: "followUp" });
    });

    it("wakes an idle pi session with the background wait when a message arrives", async () => {
        const s = ids()("wake");
        const sender = ids()("sender");
        const pi = await started(s);
        await kit.hook("codex", "SessionStart", sender);
        await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s));
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        // The Stop is over and the wait is up at the host (it shows the session as listening): the message can only arrive through the wait.
        await until(async () => (await kit.status(`pi:${s}`)) === "listening");

        await kit.send(sender, (await kit.profile(`pi:${s}`))!.name, "wake up");
        await until(() => pi.userMessages.length === 1);
        expect(pi.userMessages[0].text).toContain("wake up");
        expect(pi.userMessages[0].opts).toEqual({ deliverAs: "followUp" });
    });

    it("makes a tool call from the pi process as the session it reported: the first of the adapter's ancestors it knows, on its machine", async () => {
        const s = ids()("tool");
        await started(s);
        const { hostname, platform, environment } = machineInfo();
        // The extension runs in this process, so its hooks name process.pid; npx and sh stand between pi and the adapter.
        const res = await host.callTool<{ self: { id: string } }>("peers", {}, "pi-instance",
            { client: "pi", clientPids: [2147483000, 2147483001, process.pid], machine: { hostname, platform, environment } });
        expect(res.status, res.body).toBe(200);
        expect(res.payload.result?.self).toMatchObject({ id: `pi:${s}` });

        // The same process ID on another machine is another process: no session of this one.
        const other = await host.callTool("peers", {}, "pi-other",
            { client: "pi", clientPids: [process.pid], machine: { hostname: "elsewhere", platform, environment } });
        expect(other.status, other.body).toBe(400);
        expect(other.payload.error).toBe(NO_AGENT_SESSION_ERROR);
    });

    it("does not continue a run the user aborted: Stop is not sent and nothing wakes the session", async () => {
        const s = ids()("abort");
        const sender = ids()("sender");
        const pi = await started(s);
        await kit.hook("codex", "SessionStart", sender);
        await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s));
        await kit.send(sender, (await kit.profile(`pi:${s}`))!.name, "while you were busy");
        const before = hooks.started();
        await pi.emit("agent_settled", { aborted: true }, ctxOf(s));
        // Neither the Stop hook nor the background wait was started: the extension starts each as it handles the event.
        expect(hooks.started()).toBe(before);
        expect(pi.userMessages).toEqual([]);
        // The message is still to be announced: the user's next prompt gets it.
        const prompt = await pi.emit("before_agent_start", { messageType: "user", prompt: "next" }, ctxOf(s)) as { message: { content: string } };
        expect(prompt.message.content).toContain("while you were busy");
        expect(pi.userMessages).toEqual([]);
    });

    it("keeps the session when pi reloads its extensions", async () => {
        const s = ids()("reload");
        const pi = await started(s);
        await pi.emit("session_shutdown", { reason: "reload" }, ctxOf(s));
        expect(await kit.status(`pi:${s}`)).not.toBe("offline");
    });

    it("ends the session when pi shuts down, and the session is offline", async () => {
        const s = ids()("end");
        const pi = await started(s);
        expect(await kit.status(`pi:${s}`)).toBe("idle");
        await pi.emit("session_shutdown", { reason: "quit" }, pi.shutdownCtx);
        expect(await kit.status(`pi:${s}`)).toBe("offline");
    });

    it("ends the session after the Stop of a run that pi exits right after (pi -p)", async () => {
        const s = ids()("print");
        const pi = await started(s);
        await pi.emit("before_agent_start", { messageType: "user", prompt: "hi" }, ctxOf(s));
        // pi fires agent_settled and, without waiting for its handlers' work, session_shutdown.
        await pi.emit("agent_settled", { aborted: false }, ctxOf(s));
        await pi.emit("session_shutdown", { reason: "quit" }, pi.shutdownCtx);
        // Every hook the extension started has ended, the Stop too: none can still reach the host after the session end.
        await hooks.done();
        expect(await kit.status(`pi:${s}`)).toBe("offline");
    });
});

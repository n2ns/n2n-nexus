import { expect, it } from "vitest";
import { until, useHost } from "./conformance/harness.js";
import { ctxOf, piKit } from "./helpers/pi.js";

const host = useHost();
const { started, hooks } = piKit(host, async () => {}, "pi-offline");

it("reuses one real background process across turns while the host is offline", async () => {
    await host.stop();
    const id = "offline-wait-reuse";
    const pi = await started(id);
    for (let turn = 0; turn < 4; turn++) {
        await pi.emit("before_agent_start", { messageType: "user", prompt: "next" }, ctxOf(id));
        await pi.emit("agent_settled", { aborted: false }, ctxOf(id));
        await until(() => hooks.runningHooks() === 0 && hooks.waiting() > 0);
        expect(hooks.waiting()).toBe(1);
    }
    await pi.emit("session_shutdown", { reason: "quit" }, pi.shutdownCtx);
    await hooks.done();
    expect(hooks.waiting()).toBe(0);
});

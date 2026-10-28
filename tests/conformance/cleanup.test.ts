// host_maintenance cleanup and export, driven by POST /test/clock (test build only),
// with meetingRetentionDays 2 and retentionDays 1.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";
import { agentKit, ids, nameOf, TEST_MACHINE } from "./agents.js";

const DAY = 24 * 60 * 60 * 1000;

type Report = {
    dryRun: boolean;
    counts: Record<string, number>;
    meetings: { id: string; topic: string; action: string }[];
    sessions: { id: string; name: string }[];
};

describe("cleanup", () => {
    const host = useHost({ rateLimit: 0, meetingRetentionDays: 2, retentionDays: 1 });
    const { hook, codexTool } = agentKit(host);

    async function cleanup(dryRun = false): Promise<Report> {
        const res = await host.callTool<{ cleanup: Report }>("host_maintenance", { action: "cleanup", dryRun }, "admin");
        expect(res.status, res.body).toBe(200);
        return res.payload.result!.cleanup;
    }
    const meetingStatus = async (id: string) => {
        const res = await host.callTool<{ meetings: { id: string; status: string; endReason: string | null }[] }>("list_meetings", {}, "admin");
        return res.payload.result!.meetings.find((m) => m.id === id);
    };

    it("closes a silent meeting, removes old sessions and meetings, and keeps who wrote what", async () => {
        const s = ids();
        const t0 = Date.now() + 100 * DAY;
        await host.setClock(t0);
        await hook("codex", "SessionStart", s("w"));
        const started = await codexTool<{ meetingId: string }>(s("w"), "start_meeting", { topic: "Silent" });
        expect(started.status, started.body).toBe(200);
        const id = started.payload.result!.meetingId;
        expect((await codexTool(s("w"), "send_message", { meetingId: id, message: "only words" })).status).toBe(200);
        await hook("codex", "SessionEnd", s("w"));

        // Two days to the millisecond: nothing to do for the meeting yet.
        await host.setClock(t0 + 2 * DAY);
        expect((await cleanup(true)).meetings).toEqual([]);

        await host.setClock(t0 + 2 * DAY + 1);
        const dry = await cleanup(true);
        const name = nameOf("codex", "proj", s("w"));
        expect(dry).toMatchObject({ dryRun: true, meetings: [{ id, topic: "Silent", action: "expire" }], sessions: [{ id: `codex:${s("w")}`, name }] });
        expect(dry.counts.meetingsExpired).toBe(1);
        expect(await meetingStatus(id)).toMatchObject({ status: "active" });

        const done = await cleanup();
        expect(done).toMatchObject({ dryRun: false, meetings: dry.meetings, sessions: dry.sessions });
        expect(await meetingStatus(id)).toMatchObject({ status: "closed", endReason: "expired" });
        const events = await host.callTool<{ events: { action: string }[] }>("list_events", { action: "maintenance" }, "admin");
        expect(events.payload.result!.events.map((e) => e.action)).toContain("maintenance.cleanup");

        // The session is gone; its message still says who wrote it and where.
        const history = await host.callTool<{ messages: { text: string; senderName: string; senderMachine: string; senderBackfilled: boolean }[] }>(
            "read_messages", { meetingId: id, latest: true }, "admin");
        expect(history.payload.result!.messages.find((m) => m.text === "only words")).toMatchObject({
            senderName: name, senderMachine: `${TEST_MACHINE.hostname} · Linux`, senderBackfilled: false });
        const md = (await host.callTool<{ markdown: string }>("host_maintenance", { action: "export", meetingId: id }, "admin")).payload.result!.markdown;
        expect(md).toContain("# Silent\n");
        expect(md).toContain(`${name} (${TEST_MACHINE.hostname} · Linux)`);
        expect(md).toContain("only words");

        // Again: nothing more. Two days after it closed, the meeting goes.
        const again = await cleanup();
        expect(again.meetings).toEqual([]);
        expect(again.sessions).toEqual([]);
        await host.setClock(t0 + 4 * DAY + 2);
        expect((await cleanup()).meetings).toEqual([{ id, topic: "Silent", action: "delete" }]);
        expect(await meetingStatus(id)).toBeUndefined();
        const gone = await host.callTool("host_maintenance", { action: "export", meetingId: id }, "admin");
        expect(gone.status).toBe(400);
    });
});

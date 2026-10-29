// Every tool's result satisfies its output schema in contract/tools.json.
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { TOOLS_CONTRACT, useHost } from "./harness.js";
import { TEST_MACHINE } from "./agents.js";

const host = useHost({ rateLimit: 0 });
const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(TOOLS_CONTRACT.tools.map((t) => [t.name, ajv.compile(t.outputSchema)]));

const manifest = (id: string, relations: { targetId: string; type: string }[] = []) => ({
    id, name: id, description: "d", techStack: ["ts"], relations,
    repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
});

describe("tool results", () => {
    it("match each tool's output schema", async () => {
        for (const session of ["me", "peer"]) {
            const hook = await host.request("POST", "/api/hook", { client: "codex", input: { hook_event_name: "SessionStart", session_id: session, cwd: "/work", machine: TEST_MACHINE } });
            expect(hook.status).toBe(200);
        }

        const called = new Set<string>();
        // A Codex client: direct-message tools resolve the caller from its session id.
        const call = async (name: string, args: Record<string, unknown> = {}, sessionId = "me") => {
            const res = await host.callTool<Record<string, unknown>>(name, args, "structured", { client: "codex", sessionId });
            expect(res.status, `${name}: ${res.body}`).toBe(200);
            expect(res.payload.ok).toBe(true);
            const result = res.payload.result!;
            const validate = validators[name];
            expect(validate(result), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(result)}`).toBe(true);
            expect(result.refused, `${name} refused: ${JSON.stringify(result)}`).toBeUndefined();
            called.add(name);
            return result;
        };
        // A call refused for unread meeting messages: its result is valid too.
        const refused = async (name: string, args: Record<string, unknown>, sessionId: string) => {
            const res = await host.callTool<Record<string, unknown>>(name, args, "structured", { client: "codex", sessionId });
            const result = res.payload.result!;
            const validate = validators[name];
            expect(validate(result), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(result)}`).toBe(true);
            expect(result).toMatchObject({ ok: false, refused: true });
        };

        await call("sync_project_assets", { manifest: manifest("web_b"), internalDocs: "# b" });
        await call("sync_project_assets", { manifest: manifest("web_a", [{ targetId: "web_b", type: "dependency" }]), internalDocs: "# a" });
        await call("upload_project_asset", { projectId: "web_a", fileName: "a.txt", base64Content: Buffer.from("x").toString("base64") });
        await call("update_project", { projectId: "web_a", patch: { description: "new" } });
        await call("search_projects", { query: "web" });
        await call("get_global_topology", {});
        await call("get_global_topology", { projectId: "web_a" });
        await call("get_project", { projectId: "web_a" });
        await call("get_project", { projectId: "web_a", includeDocs: false });
        await call("send_message", { message: "global hi", category: "UPDATE" });
        await call("read_messages", { count: 5 });
        await call("read_messages", { latest: true, count: 5 });
        await call("peers");
        await call("peers", { includeOffline: true });
        await call("set_profile", { name: "contract-test", note: "checking contracts", title: "Contract test" });
        await call("listen", { on: false });
        await call("send", { to: "codex:peer", text: "direct hi", notifyWhenIdle: true });
        const inbox = await call("read", {}, "peer") as { messages: { messageId: string }[] };
        await call("reply", { messageId: inbox.messages[0].messageId, text: "direct reply" }, "peer");
        await call("read", {});
        const meeting = await call("start_meeting", { topic: "Plan" });
        await call("send_message", { message: "in meeting", category: "DECISION" });
        await call("read_messages", { meetingId: meeting.meetingId, count: 5 });
        await call("host_maintenance", { action: "export", meetingId: meeting.meetingId });
        await call("read_messages", { meetingId: meeting.meetingId, afterId: 0 }, "peer");
        await call("join_meeting", { meetingId: meeting.meetingId, mode: "async", since: "beginning" }, "peer");
        const draft = await call("send_message", { meetingId: meeting.meetingId, message: "the plan", draft: true });
        await refused("send_message", { meetingId: meeting.meetingId, message: "unread" }, "peer");
        await call("send_message", { meetingId: meeting.meetingId, message: "goes through" }, "peer");
        await call("read_messages", { meetingId: meeting.meetingId });
        await call("send_message", { meetingId: meeting.meetingId, message: "more" });
        await refused("stance", { meetingId: meeting.meetingId, messageId: draft.currentProposalId, stance: "object", note: "not yet, see #1" }, "peer");
        await call("stance", { meetingId: meeting.meetingId, messageId: draft.currentProposalId, stance: "object", note: "not yet, see #1" }, "peer");
        await call("read_messages", { meetingId: meeting.meetingId });
        await call("stance", { meetingId: meeting.meetingId, messageId: draft.currentProposalId, stance: "endorse" });
        await call("list_meetings", {});
        // The user's seat: its approval of the draft, a proposed end by another, its end.
        const seated = await call("start_meeting", { topic: "Seated", seat: "user" });
        await call("join_meeting", { meetingId: seated.meetingId, since: "beginning" }, "peer");
        await call("read_messages", { meetingId: seated.meetingId }, "peer");
        const seatDraft = await call("send_message", { meetingId: seated.meetingId, message: "point", draft: true }, "peer");
        await call("read_messages", { meetingId: seated.meetingId });
        await call("stance", { meetingId: seated.meetingId, messageId: seatDraft.currentProposalId, stance: "endorse" });
        await call("list_meetings", {});
        await refused("end_meeting", { meetingId: seated.meetingId, summary: "done" }, "peer");
        await call("end_meeting", { meetingId: seated.meetingId, summary: "done" });
        await call("leave_meeting", { meetingId: meeting.meetingId }, "peer");
        await call("end_meeting", { meetingId: meeting.meetingId, summary: "done" });
        await call("archive_meeting", { meetingId: meeting.meetingId });
        await call("reopen_meeting", { meetingId: meeting.meetingId });
        await call("update_global_strategy", { content: "# S" });
        await call("get_global_strategy", {});
        await call("sync_global_doc", { docId: "d1", title: "D1", content: "# d" });
        await call("list_global_docs", {});
        await call("get_global_doc", { docId: "d1" });
        const task = await call("create_task", { metadata: { k: "v" }, ttl: 60000 });
        await call("get_task", { taskId: task.task_id });
        await call("list_tasks", {});
        await call("update_task", { taskId: task.task_id, status: "running", progress: 0.5, result_uri: "file:///r", metadata: { k: "w" } });
        await call("cancel_task", { taskId: task.task_id });
        await call("list_events", { limit: 50 });
        await call("rename_project", { oldId: "web_b", newId: "web_c" });
        await call("host_maintenance", { action: "prune", count: 1 });
        await call("host_maintenance", { action: "clear" });
        await call("host_maintenance", { action: "cleanup", dryRun: true });
        await call("host_maintenance", { action: "cleanup" });
        await call("host_delete_project", { projectId: "web_c" });

        const expected = TOOLS_CONTRACT.tools.map((t) => t.name);
        expect([...called].sort()).toEqual(expected.sort());
    });
});

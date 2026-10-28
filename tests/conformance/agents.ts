/**
 * Helpers for the agent-session tests (hooks and direct-message tools), over HTTP only.
 *
 * Tests in a file share one host, so each test names its sessions through
 * `ids()` (unique per test) and `endSessions()` (afterEach) ends every session
 * a test touched: names are then free again and nothing is left online.
 * Session state is read through an observer session's `peers` call; the
 * observer exists only offline between reads, so it never shows up in
 * SessionStart introductions or peer lists of the tests.
 */
import { expect } from "vitest";
import { HOOK, type Host, type HttpResponse, type ToolReply } from "./harness.js";

export type HookClient = "claude" | "codex";
export type HookOutput = {
    decision?: string;
    reason?: string;
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    wake?: string;
    dispatchId?: string;
    timeout?: boolean;
} | null;
export type Profile = {
    id: string; name: string; title: string; client: HookClient; cwd: string; hostname: string; platform: string; environment: string; utcOffset: number; label: string;
    note: string; status: string; lastActiveAt: string;
};

export const { noticePrefix: NOTICE_PREFIX, notifyClosing: NOTIFY_CLOSING, stopClosing: STOP_CLOSING, statusNote: STATUS_NOTE,
    sessionStartClosing: SESSION_START_CLOSING, collaborationRules: COLLABORATION_RULES, messageTrustNote: MESSAGE_TRUST_NOTE, messageEnd: MESSAGE_END,
    messageCut: MESSAGE_CUT, replyInstruction: REPLY_INSTRUCTION, readRest: READ_REST, replyTool: REPLY_TOOL, noAgentSessionError: NO_AGENT_SESSION_ERROR } = HOOK.texts;
export const BACKGROUND_WAIT_EVENT = HOOK.backgroundWaitEvent;
/** A session's own name: <client>@<dir>#<the last 4 letters and digits of its client session id>. */
export const nameOf = (client: HookClient, dir: string, sessionId: string, length = 4) =>
    `${client}@${dir}#${sessionId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(-length)}`;
/** Where every test session runs unless a test says otherwise. */
export const TEST_MACHINE = { hostname: "box", platform: "linux", environment: "", utcOffset: 0 };
export const WAKE_RESULT_EVENT = HOOK.wakeResultEvent;

const OBSERVER = "conformance-observer";
let testSeq = 0;

export function agentKit(host: Host) {
    const touched = new Map<string, HookClient>();
    let toolUseSeq = 0;

    const track = (client: HookClient, input: Record<string, unknown>) => {
        if (typeof input.session_id === "string" && input.session_id) touched.set(`${client}:${input.session_id}`, client);
    };
    /** The machine each session reported last, sent again with its later events as a real client does. */
    const machines = new Map<string, unknown>();
    const withMachine = (client: HookClient, sessionId: string, extra: Record<string, unknown>) => {
        const key = `${client}:${sessionId}`;
        if ("machine" in extra) {
            machines.set(key, extra.machine);
            return extra;
        }
        return { machine: machines.get(key) ?? TEST_MACHINE, ...extra };
    };

    /** POST /api/hook with cwd /work/proj and TEST_MACHINE unless `extra` says otherwise. */
    const hookRaw = (client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}) => {
        const input = { hook_event_name: event, session_id: sessionId, cwd: "/work/proj", ...withMachine(client, sessionId, extra) };
        track(client, input);
        return host.request<{ output?: HookOutput; ok?: boolean; error?: string }>("POST", "/api/hook", { client, input });
    };

    async function hook(client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}): Promise<HookOutput> {
        const res = await hookRaw(client, event, sessionId, extra);
        expect(res.status, res.body).toBe(200);
        return res.payload.output ?? null;
    }

    /** A hook request held open (listening Stop, background wait); `cancel` kills it as the client does. No cwd, like the waiting hooks. */
    function openHook(client: HookClient, event: string, sessionId: string, extra: Record<string, unknown> = {}) {
        const input = { hook_event_name: event, session_id: sessionId, ...withMachine(client, sessionId, extra) };
        track(client, input);
        const { response, cancel } = host.openRequest<{ output: HookOutput }>("POST", "/api/hook", { client, input });
        return { response, cancel };
    }

    /** Call a tool as a Claude session: PreToolUse binds a fresh toolUseId first. */
    async function claudeTool<T>(sessionId: string, tool: string, args: Record<string, unknown> = {}): Promise<HttpResponse<ToolReply<T>>> {
        const toolUseId = `toolu_${++toolUseSeq}_${sessionId}`;
        expect(await hook("claude", "PreToolUse", sessionId, { tool_use_id: toolUseId, tool_name: `mcp__n2n-nexus__${tool}` })).toBeNull();
        return host.callTool<T>(tool, args, "i1", { client: "claude", toolUseId });
    }

    const codexTool = <T>(sessionId: string, tool: string, args: Record<string, unknown> = {}) =>
        host.callTool<T>(tool, args, "i2", { client: "codex", sessionId });

    async function send(fromCodex: string, to: string, text: string, notifyWhenIdle = false): Promise<string> {
        const res = await codexTool<{ messageId: string }>(fromCodex, "send", { to, text, notifyWhenIdle });
        expect(res.status, res.body).toBe(200);
        return res.payload.result!.messageId;
    }

    /** Every session the host lists (offline ones active within the peer window included), read by the observer. */
    async function sessions(): Promise<Profile[]> {
        // SessionEnd creates the observer offline (or ends it again after the previous read).
        expect((await host.request("POST", "/api/hook", { client: "codex", input: { hook_event_name: "SessionEnd", session_id: OBSERVER, cwd: "/observer", machine: TEST_MACHINE } })).status).toBe(200);
        const res = await host.callTool<{ peers: Profile[] }>("peers", { includeOffline: true }, "observer", { client: "codex", sessionId: OBSERVER });
        expect(res.status, res.body).toBe(200);
        expect((await host.request("POST", "/api/hook", { client: "codex", input: { hook_event_name: "SessionEnd", session_id: OBSERVER, cwd: "/observer", machine: TEST_MACHINE } })).status).toBe(200);
        return res.payload.result!.peers;
    }

    const profile = async (id: string) => (await sessions()).find((p) => p.id === id);
    const status = async (id: string) => (await profile(id))?.status;

    /** End every session the current test touched. */
    async function endSessions() {
        for (const [key, client] of touched) {
            await host.request("POST", "/api/hook", { client, input: { hook_event_name: "SessionEnd", session_id: key.slice(client.length + 1), machine: TEST_MACHINE } });
        }
        touched.clear();
    }

    return { hookRaw, hook, openHook, claudeTool, codexTool, send, sessions, profile, status, endSessions };
}

/** Session ids unique to one test: ids()("a") gives "t<n>-a". */
export function ids() {
    const prefix = `t${++testSeq}`;
    return (name: string) => `${prefix}-${name}`;
}

export const context = (out: HookOutput) => out?.hookSpecificOutput?.additionalContext ?? "";

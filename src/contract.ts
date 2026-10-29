/**
 * The part of the host contract the clients use: the MCP adapter and the
 * `n2n-nexus hook` / `install` / `doctor` commands. Types and constants only:
 * the hook command imports this on every client event, so it must not pull in
 * zod or the MCP SDK. The values come from contract/hook.json, which the host
 * (n2n-nexus-host) embeds too.
 *
 * Identity: every Claude Code / Codex conversation is one agent session with
 * id `<client>:<client session id>`. Hooks create and update sessions; tool
 * calls name their session through a {@link Caller} built from the MCP
 * request's `_meta`, never from model-supplied arguments.
 */

import fs from "node:fs";

/** contract/hook.json, next to src/ and build/ in the package. */
const contract = JSON.parse(fs.readFileSync(new URL("../contract/hook.json", import.meta.url), "utf8"));

/** Protocol version of this client; the host reports its own in GET /health. */
export const CONTRACT_VERSION: number = contract.contractVersion;

export const HOOK_CLIENTS = contract.clients as readonly ["claude", "codex"];
export type HookClient = typeof HOOK_CLIENTS[number];

export function isHookClient(value: unknown): value is HookClient {
    return typeof value === "string" && (HOOK_CLIENTS as readonly string[]).includes(value);
}

/**
 * Who is calling a tool, as the adapter read it from the MCP request.
 * Claude Code: `_meta["claudecode/toolUseId"]`, bound to a session by the
 * PreToolUse hook that ran just before the call. Codex: `_meta.sessionId`
 * (a sub-agent carries its parent's session id).
 */
export type Caller =
    | { client: "claude"; toolUseId: string }
    | { client: "codex"; sessionId: string };

/** MCP clientInfo names the adapter maps to a hook client. */
export const CLIENT_INFO_NAMES: Record<HookClient, string> = contract.clientInfoNames;
export const CLAUDE_TOOL_USE_META_KEY: string = contract.meta.claudeToolUseKey;
export const CODEX_SESSION_META_KEY: string = contract.meta.codexSessionKey;

/**
 * Hook stdin fields the host uses. The hook command forwards only these (plus
 * `title` on SessionStart, UserPromptSubmit and Stop, see cli/title.ts):
 * PostToolUse stdin also carries the whole tool input and response, which can
 * be large and runs on every tool call.
 */
export const HOOK_INPUT_FIELDS: readonly string[] = contract.hookInputFields;

/** POST /api/hook request: the HOOK_INPUT_FIELDS present in the hook's stdin JSON, and the conversation's title on some events. */
export type HookRequest = { client: HookClient; input: Record<string, unknown> };
/** POST /api/hook response: `output` is printed to stdout as JSON; null prints nothing. */
export type HookResponse = { output: Record<string, unknown> | null };

/**
 * Pseudo hook event of the background wait (`n2n-nexus hook <client> --wait`):
 * started when a turn ends, it waits and returns `{ wake: text, dispatchId }` when
 * something new arrives for the session, `{ timeout: true }` when the time
 * runs out (the client asks again), or null when the session became active
 * again (the client stops). Claude delivers the text through an asyncRewake
 * hook, Codex through `codex queue`.
 */
export const BACKGROUND_WAIT_EVENT: string = contract.backgroundWaitEvent;

/**
 * Pseudo hook event with which the Codex background wait reports whether
 * `codex queue` took a wake: input `{ session_id, dispatch_id, ok }`. On
 * `ok: false` the host undoes the wake, so its messages and notices wake the
 * session again.
 */
export const WAKE_RESULT_EVENT: string = contract.wakeResultEvent;

/** HTTP timeout of the hook command: a listening Stop may wait long, every other event is quick. */
export const HOOK_STOP_REQUEST_TIMEOUT_MS: number = contract.timing.hookStopRequestTimeoutMs;
export const HOOK_REQUEST_TIMEOUT_MS: number = contract.timing.hookRequestTimeoutMs;
/** `timeout` (seconds) written into the client hook configuration. */
export const HOOK_STOP_TIMEOUT_SEC: number = contract.timing.hookStopTimeoutSec;
/** `timeout` (seconds) of the background wait hook; a conversation idle for longer is not woken. */
export const WAIT_HOOK_TIMEOUT_SEC: number = contract.timing.waitHookTimeoutSec;
export const HOOK_TIMEOUT_SEC: number = contract.timing.hookTimeoutSec;
/** `timeout` (seconds) of the Codex SessionEnd hook: Codex clamps a longer one to 3 s and warns about it. */
export const CODEX_SESSION_END_TIMEOUT_SEC: number = contract.timing.codexSessionEndTimeoutSec;
/** HTTP timeout of a SessionEnd hook, which is not resent after a timeout so it ends within CODEX_SESSION_END_TIMEOUT_SEC. */
export const SESSION_END_REQUEST_TIMEOUT_MS: number = contract.timing.sessionEndRequestTimeoutMs;
/** After a failed `codex queue`, the Codex wait asks again after this delay, doubled on each failure up to the maximum. */
export const WAKE_RETRY_FIRST_DELAY_MS: number = contract.timing.wakeRetryFirstDelayMs;
export const WAKE_RETRY_MAX_DELAY_MS: number = contract.timing.wakeRetryMaxDelayMs;

/**
 * The hook command adds the conversation's title, as its client shows it, to
 * the input it forwards as `title` (at most this many characters).
 */
export const MAX_TITLE_CHARS: number = contract.limits.maxTitleChars;

/** Name the MCP server is installed under; Claude's PreToolUse matcher depends on it. */
export const MCP_SERVER_NAME: string = contract.mcpServerName;
export const CLAUDE_PRE_TOOL_MATCHER = `mcp__${MCP_SERVER_NAME}__.*`;

/** Payload of a LAN discovery query datagram; the host answers only this. */
export const DISCOVERY_QUERY: string = contract.discoveryQuery;

/** Where to get the host. */
export const HOST_RELEASES_URL = "https://github.com/n2ns/n2n-nexus/releases";
/** What to do when no host answers at a loopback endpoint: clients never start one themselves. */
const NO_HOST_HINT =
    `Install n2n-nexus-host (${HOST_RELEASES_URL}) and start it: run the tray app, or "n2n-nexus-host serve".`;
/** The same for another machine's endpoint: a host started here would not be the one asked for. */
const NO_REMOTE_HOST_HINT =
    "The host at that address is not reachable; it must be started on that machine (n2n-nexus-host there with LAN access on, or \"n2n-nexus-host serve --host <address>\").";

/** NO_HOST_HINT for a loopback endpoint (127.x, localhost, ::1), else NO_REMOTE_HOST_HINT. */
export function noDaemonHint(endpoint: string): string {
    let host: string;
    try {
        host = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`).hostname;
    } catch {
        return NO_HOST_HINT;                // a mistyped endpoint: the request itself reports it
    }
    const loopback = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
    return loopback ? NO_HOST_HINT : NO_REMOTE_HOST_HINT;
}

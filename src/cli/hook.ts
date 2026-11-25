/**
 * `n2n-nexus hook <claude|codex|pi> [--endpoint <url>] [--wait]` and
 * `n2n-nexus hook antigravity <Event>|--wait [--endpoint <url>]`: forward one client
 * hook event to the daemon and print its output, or with `--wait` run the
 * background wait that wakes an idle conversation. Runs on every tool call, so
 * it loads only node built-ins (no MCP SDK or zod; node:sqlite only to read a
 * Codex conversation's title, see title.ts), and every failure
 * is silent: exit 0 with nothing on stdout, so the client carries on unaffected.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    BACKGROUND_WAIT_EVENT, WAKE_RESULT_EVENT, HOOK_INPUT_FIELDS, HOOK_REQUEST_TIMEOUT_MS, HOOK_STOP_REQUEST_TIMEOUT_MS, SESSION_END_REQUEST_TIMEOUT_MS, WAIT_HOOK_TIMEOUT_SEC, WAKE_RETRY_FIRST_DELAY_MS, WAKE_RETRY_MAX_DELAY_MS, noDaemonHint,
    isHookClient, type HookClient, type HookResponse
} from "../contract.js";
import { NexusClient, NexusTransportError, REQUEST_TIMEOUT_CODE } from "../client/nexus-client.js";
import { DISCOVER_ENDPOINT, configuredEndpoint, resolveEndpoint } from "../client/discovery.js";
import { SHELL_NAMES, hookClientPid, parsePid, processAlive } from "./client-process.js";
import { machineInfo } from "./machine.js";
import { cleanTitle, readTitle } from "./title.js";

/** Errors after which a discovered daemon is looked up again: it was never reached, so resending is safe. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EADDRNOTAVAIL"]);
/** Events whose forwarded input carries the conversation's title. */
const TITLE_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "Stop"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

function argValue(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
}

/** The client named by `<client> [--endpoint <url>]` and the configured endpoint; throws on an unknown client. */
function clientAndEndpoint(argv: string[]): { client: HookClient; configured: string } {
    const client = argv[0];
    if (!isHookClient(client)) throw new Error(`unknown client "${client ?? ""}" (expected claude, codex, pi or antigravity)`);
    return { client, configured: configuredEndpoint(argValue(argv, "--endpoint")) };
}

/**
 * An Antigravity hook's input (camelCase, `n2n-nexus hook antigravity <Event>`) as the
 * fields the host reads, or undefined for an event the host has nothing to do with.
 * The event is the registered argument, else the input's `hookEventName`.
 * PreInvocation starts each model call: the first of a turn (`invocationNum` 0) is
 * its prompt, later ones are mid-turn like a tool result. A Stop that continues a
 * Stop's continuation has `executionNum` above 0.
 */
export function antigravityInput(argv: string[], stdin: Record<string, unknown>): Record<string, unknown> | undefined {
    const event = argv[1] && !argv[1].startsWith("--") ? argv[1] : stdin.hookEventName;
    const input: Record<string, unknown> = {};
    if (typeof stdin.conversationId === "string") input.session_id = stdin.conversationId;
    const workspace = Array.isArray(stdin.workspacePaths) ? stdin.workspacePaths.find((p): p is string => typeof p === "string" && p !== "") : undefined;
    const cwd = workspace ?? (typeof stdin.cwd === "string" && stdin.cwd ? stdin.cwd : undefined);
    if (cwd !== undefined) input.cwd = cwd;
    switch (event) {
        case "SessionStart": {
            input.hook_event_name = "SessionStart";
            const title = cleanTitle(stdin.lastUserInput);
            if (title !== undefined) input.title = title;
            return input;
        }
        case "PreInvocation":
            input.hook_event_name = typeof stdin.invocationNum === "number" && stdin.invocationNum > 0 ? "PostToolUse" : "UserPromptSubmit";
            return input;
        case "Stop":
            input.hook_event_name = "Stop";
            input.stop_hook_active = typeof stdin.executionNum === "number" && stdin.executionNum > 0;
            return input;
    }
    return undefined;
}

/** Returns the text to print on stdout ("" for nothing); throws on any failure. */
async function forward(argv: string[]): Promise<string> {
    const { client, configured } = clientAndEndpoint(argv);

    const stdin: unknown = JSON.parse(await readStdin());
    if (!isPlainObject(stdin)) throw new Error("hook input is not a JSON object");
    // Antigravity reads `{}` as "nothing to add".
    const nothing = client === "antigravity" ? "{}\n" : "";
    let input: Record<string, unknown> = {};
    if (client === "antigravity") {
        const mapped = antigravityInput(argv, stdin);
        if (!mapped) return nothing;
        input = mapped;
    } else {
        for (const field of HOOK_INPUT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(stdin, field)) input[field] = stdin[field];
        }
        // The title is read only where the host updates it, not on the frequent tool events.
        if (typeof stdin.hook_event_name === "string" && TITLE_EVENTS.has(stdin.hook_event_name)) {
            const title = await readTitle(client, stdin);
            if (title !== undefined) input.title = title;
        }
    }
    const event = input.hook_event_name;
    if (event === "SessionStart") {
        try {
            const { clientScheduleNeedsSetup } = await import("./update-schedule.js");
            if (clientScheduleNeedsSetup()) {
                const worker = fileURLToPath(new URL("../../autoupdate/postinstall.mjs", import.meta.url));
                await startDetached(process.execPath, [worker, "--session-start"]);
            }
        } catch { /* The hook still forwards the event if the scheduler is unavailable. */ }
    }
    // Every event says where the conversation runs; the host refuses one without it.
    input.machine = machineInfo();
    // A pi process names itself (--client-pid, its extension passes it): tool calls from it find the session.
    if (client === "pi") {
        const pid = parsePid(argValue(argv, "--client-pid"));
        if (pid !== undefined) input.client_pid = pid;
    }
    // SessionEnd must finish within Codex's 3 s hook limit (discovery included): a short budget and a single attempt.
    const sessionEnd = event === "SessionEnd";
    const timeoutMs = event === "Stop" ? HOOK_STOP_REQUEST_TIMEOUT_MS : sessionEnd ? SESSION_END_REQUEST_TIMEOUT_MS : HOOK_REQUEST_TIMEOUT_MS;

    /** Send to `endpoint`; nothing listening there is reported with what to do about it. */
    const send = async (endpoint: string): Promise<HookResponse> => {
        try {
            return await new NexusClient({ endpoint }).hook({ client, input }, timeoutMs);
        } catch (error) {
            if (!(error instanceof NexusTransportError && error.code === "ECONNREFUSED")) throw error;
            throw new NexusTransportError(`No n2n-nexus-host at ${endpoint}. ${noDaemonHint(endpoint)}`, error.code);
        }
    };

    const endpoint = await resolveEndpoint(configured);
    let response: HookResponse;
    try {
        response = await send(endpoint);
    } catch (error) {
        // The cached daemon is gone: look again, and fall back to the local endpoint if none answers.
        // A timed-out Stop may have been waiting for messages on purpose, so only other events count a timeout.
        const code = error instanceof NexusTransportError ? error.code ?? "" : "";
        const unreachable = UNREACHABLE_CODES.has(code) || (code === REQUEST_TIMEOUT_CODE && event !== "Stop");
        if (configured !== DISCOVER_ENDPOINT || !unreachable || sessionEnd) throw error;
        const found = await resolveEndpoint(configured, { fresh: true });
        if (found === endpoint) throw error;
        response = await send(found);
    }

    if (!isPlainObject(response) || !("output" in response)) throw new Error("invalid response from n2n-nexus-host");
    const { output } = response;
    if (output === null) return nothing;
    if (!isPlainObject(output)) throw new Error("invalid output from n2n-nexus-host");
    return JSON.stringify(output) + "\n";
}

/** The background wait ends before the client's hook timeout would kill it during a request. */
const WAIT_DEADLINE_MS = (WAIT_HOOK_TIMEOUT_SEC - 10) * 1000;

/** A wake from the host: the notification text and the id its delivery is reported under. */
type Wake = { text: string; dispatchId: string; endpoint: string };

const WAIT_RETRY_CODES = new Set([...UNREACHABLE_CODES, "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", REQUEST_TIMEOUT_CODE]);

/**
 * Ask the daemon until something arrives for the session (the wake), the
 * session becomes active again, the deadline passes or, checked before each
 * request, `stop` says the client is gone (null).
 */
export async function waitForWake(client: HookClient, sessionId: string, configured: string, deadlineMs = WAIT_DEADLINE_MS, stop: () => boolean = () => false): Promise<Wake | null> {
    const deadline = Date.now() + deadlineMs;
    let endpoint = await resolveEndpoint(configured);
    let delay = WAKE_RETRY_FIRST_DELAY_MS;
    let fresh = false;
    while (Date.now() < deadline) {
        if (fresh) endpoint = await resolveEndpoint(configured, { fresh: true });
        const remaining = deadline - Date.now();
        if (remaining <= 0 || stop()) return null;
        let response: HookResponse;
        try {
            response = await new NexusClient({ endpoint }).hook({ client, input: { hook_event_name: BACKGROUND_WAIT_EVENT, session_id: sessionId } }, Math.min(HOOK_STOP_REQUEST_TIMEOUT_MS, remaining));
        } catch (error) {
            if (!(error instanceof NexusTransportError) || !WAIT_RETRY_CODES.has(error.code ?? "")) throw error;
            if (Date.now() + delay >= deadline) return null;
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, WAKE_RETRY_MAX_DELAY_MS);
            fresh = true;
            continue;
        }
        fresh = false;
        delay = WAKE_RETRY_FIRST_DELAY_MS;
        const output = isPlainObject(response) ? response.output : null;
        if (isPlainObject(output) && typeof output.wake === "string" && typeof output.dispatchId === "string") return { text: output.wake, dispatchId: output.dispatchId, endpoint };
        if (!(isPlainObject(output) && output.timeout === true)) return null;
    }
    return null;
}

/**
 * The delay before the Codex wait tries again after the failed `codex queue`
 * it waited `delay` before (the first failure waits WAKE_RETRY_FIRST_DELAY_MS),
 * doubled each time, or null once it would reach WAKE_RETRY_MAX_DELAY_MS
 * (about 8.5 minutes of failures): Codex does not have the conversation loaded
 * (its terminal was closed, the app restarted), so the wait ends, and the
 * messages, undone by the failure report, wait for the user's next prompt there.
 */
export function nextQueueRetry(delay: number): number | null {
    const next = delay * 2;
    return next >= WAKE_RETRY_MAX_DELAY_MS ? null : next;
}

/**
 * `--wait`, started by a Stop hook when a turn ends. Claude runs it as an
 * asyncRewake hook: exit code 2 with the notification on stderr wakes the
 * conversation. Codex has no such hook, so its Stop hook starts a detached copy
 * (`--session <id>`) and returns at once; the copy hands the notification (one
 * line; the started turn's UserPromptSubmit hook brings the texts) to
 * `codex queue` (NEXUS_CODEX_COMMAND, default `codex`), which starts a turn,
 * and reports to the host whether it did (WAKE_RESULT_EVENT): after a failed
 * queue the host undoes the wake and the copy waits again after a delay that
 * doubles on each failure, so the same messages wake the session on a later
 * try without retrying a broken `codex` in a loop; once the delay reaches its
 * maximum the copy ends, and the messages wait for the user's next prompt.
 *
 * The wait ends when the client it would wake is gone (Claude Code's
 * CLAUDE_PID, or the Codex process the Stop hook passes as `--client-pid`),
 * checked before each request, so a client that was killed is not kept
 * listening; a wake that arrives after it is gone is reported as not delivered.
 * A request is never cut short for it: the host may already have handed over a
 * wake on it, which only a report can undo.
 */
async function runWait(argv: string[]): Promise<number> {
    const { client, configured } = clientAndEndpoint(argv);
    if (client === "antigravity") return runAntigravityWait(configured);
    // claude -p (unattended) waits for this hook before it exits, and nobody would see a woken turn.
    if (client === "claude" && process.env.CLAUDE_CODE_SESSION_ATTENDED === "0") return 0;
    let sessionId = argValue(argv, "--session");
    if (!sessionId) {
        const stdin: unknown = JSON.parse(await readStdin());
        if (!isPlainObject(stdin) || typeof stdin.session_id !== "string" || !stdin.session_id) return 0;
        sessionId = stdin.session_id;
        if (client === "codex") {
            const { entryScript } = await import("./entry.js");
            const args = [entryScript(), "hook", "codex", "--wait", "--session", sessionId, ...(argValue(argv, "--endpoint") ? ["--endpoint", configured] : [])];
            await startDetached(process.execPath, args, hookClientPid);
            return 0;
        }
    }
    const clientPid = parsePid(client === "claude" ? process.env.CLAUDE_PID : argValue(argv, "--client-pid"));
    const clientGone = () => clientPid !== undefined && !processAlive(clientPid);
    // Load what a wake needs before waiting: the wait lasts up to a day, and an
    // upgrade or a cleared npx cache may remove the package's files meanwhile.
    const { spawnClientSync } = client === "codex" ? await import("./client-command.js") : { spawnClientSync: undefined };
    const report = (wake: Wake, ok: boolean) => new NexusClient({ endpoint: wake.endpoint })
        .hook({ client, input: { hook_event_name: WAKE_RESULT_EVENT, session_id: sessionId, dispatch_id: wake.dispatchId, ok } }, HOOK_REQUEST_TIMEOUT_MS)
        .then(() => true, () => false);
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    for (let delay: number | null = WAKE_RETRY_FIRST_DELAY_MS; ; delay = nextQueueRetry(delay)) {
        const wake = await waitForWake(client, sessionId, configured, deadline - Date.now(), clientGone);
        if (wake === null) return 0;
        if (clientGone()) {
            await report(wake, false);
            return 0;
        }
        if (!spawnClientSync) {
            await new Promise<void>((resolve) => process.stderr.write(wake.text + "\n", () => resolve()));
            return 2;
        }
        // Never through cmd.exe: the text comes from another session and spans several lines.
        const queued = spawnClientSync(process.env.NEXUS_CODEX_COMMAND || "codex", ["queue", "--thread", sessionId, "--message", wake.text], { stdio: "ignore", windowsHide: true });
        const ok = !queued.error && queued.status === 0;
        const reported = await report(wake, ok);
        // Unknown result (no report): the host keeps the wake, and waiting again would deliver nothing.
        if (ok || !reported || delay === null || Date.now() + delay >= deadline) return 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}

/** What the Antigravity waiter needs, which Antigravity gives the commands its model runs (not its hooks). */
export const ANTIGRAVITY_WAIT_ENV = ["ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_AGENTAPI_EXE", "ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN"] as const;

/**
 * The program that runs `agentapi` for ANTIGRAVITY_AGENTAPI_EXE: the file itself, or for a
 * `.bat` / `.cmd` wrapper the executable its `"<exe>" agentapi %*` line names (never through
 * cmd.exe); null when a wrapper names none.
 */
export function agentapiProgram(file: string): string | null {
    const ext = path.extname(file).toLowerCase();
    if (ext !== ".bat" && ext !== ".cmd") return file;
    const exe = /"([^"]+)"\s+agentapi\s+%\*/i.exec(fs.readFileSync(file, "utf8"))?.[1];
    if (!exe) return null;
    const relative = /^%~?dp0%?\\?/i;
    return relative.test(exe) ? path.join(path.dirname(file), exe.replace(relative, "")) : exe;
}

/**
 * `n2n-nexus hook antigravity --wait`, which the model of an Antigravity conversation starts
 * as a background command (the n2n-nexus rule says how) and never stops: Antigravity starts a
 * turn when it ends. It asks the host for a wake for the conversation again and again; a null
 * answer (the session is not known to this host yet) and a host that cannot be reached or
 * refuses are retried after a delay that doubles from WAKE_RETRY_FIRST_DELAY_MS up to
 * WAKE_RETRY_MAX_DELAY_MS. A wake is handed to `agentapi send-message <conversation> <text>`,
 * which starts a turn, and reported (WAKE_RESULT_EVENT) to the host that sent it; after a failed
 * send the same delay comes first. An accepted send is never repeated: it says Antigravity took
 * the message, not that the model answered. The credentials in the environment go to agentapi
 * only, never to the host, and are never printed. Missing variables: exit 1.
 */
async function runAntigravityWait(configured: string): Promise<number> {
    const missing = ANTIGRAVITY_WAIT_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        process.stderr.write(`[n2n-nexus] hook --wait: ${missing.join(", ")} not set. Start this command as a background command of the Antigravity conversation, as the n2n-nexus rule says.\n`);
        return 1;
    }
    const conversationId = process.env.ANTIGRAVITY_CONVERSATION_ID!;
    const agentapi = agentapiProgram(process.env.ANTIGRAVITY_AGENTAPI_EXE!);
    if (!agentapi) {
        process.stderr.write("[n2n-nexus] hook --wait: ANTIGRAVITY_AGENTAPI_EXE names a wrapper without an agentapi command line.\n");
        return 1;
    }
    const note = (message: string) => process.stderr.write(`[n2n-nexus] hook --wait: ${message.replace(/\s+/g, " ").slice(0, 300)}\n`);
    let delay = WAKE_RETRY_FIRST_DELAY_MS;
    const pause = async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, WAKE_RETRY_MAX_DELAY_MS);
    };
    for (;;) {
        let wake: Wake | null;
        try {
            wake = await waitForWake("antigravity", conversationId, configured, Infinity);
        } catch (error) {
            note(error instanceof Error ? error.message : String(error));
            wake = null;
        }
        if (wake === null) {
            await pause();
            continue;
        }
        delay = WAKE_RETRY_FIRST_DELAY_MS;
        // Never through a shell: the text comes from another session and spans several lines.
        const sent = spawnSync(agentapi, ["agentapi", "send-message", conversationId, wake.text], { stdio: "ignore", windowsHide: true });
        const ok = !sent.error && sent.status === 0;
        await new NexusClient({ endpoint: wake.endpoint })
            .hook({ client: "antigravity", input: { hook_event_name: WAKE_RESULT_EVENT, session_id: conversationId, dispatch_id: wake.dispatchId, ok } }, HOOK_REQUEST_TIMEOUT_MS)
            .catch(() => undefined);
        if (!ok) {
            note(`agentapi send-message failed (${sent.error ? (sent.error as NodeJS.ErrnoException).code ?? sent.error.message : `exit code ${sent.status}`}); waiting again`);
            await pause();
        }
    }
}

/**
 * Start a program that outlives this hook, with no stdio. On Windows it is
 * started by PowerShell's Start-Process (ShellExecute), which passes no handles
 * on: a process Node spawns inherits every inheritable handle of this one, and
 * when Codex runs the hook through PowerShell (`commandWindows`) those include
 * the pipes Codex reads the hook's output from. Codex then waits for the pipes
 * until the hook's timeout and ends the wait copy with the hook. The copy gets
 * the client process as `--client-pid`: from `clientPid` on Linux and macOS,
 * found by the launching PowerShell itself on Windows.
 */
async function startDetached(file: string, args: string[], clientPid?: () => number | undefined): Promise<void> {
    if (process.platform !== "win32") {
        const pid = clientPid?.();
        spawn(file, [...args, ...(pid !== undefined ? ["--client-pid", String(pid)] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        return;
    }
    const literal = (s: string) => `'${s.replace(/['‘’‚‛]/g, "$&$&")}'`;
    // Start-Process joins -ArgumentList with spaces, so each argument is quoted for the command line itself.
    const quoted = (s: string) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
    // The client process (--client-pid) is found here, in the PowerShell that starts the copy anyway, not
    // in one of its own: the nearest ancestor of this hook that is not a shell (Codex runs commandWindows
    // through PowerShell). Not found: the copy runs without it.
    const shells = SHELL_NAMES.map(literal).join(",");
    const command = `$a = @(${args.map((a) => literal(quoted(a))).join(",")}); `
        + (clientPid ? `try { $c = ${process.ppid}; for ($i = 0; $i -lt 4; $i++) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c); if (-not $p) { break }; `
        + `if (@(${shells}) -notcontains ($p.Name -replace '[.]exe$', '').ToLower()) { $a += ${literal(quoted("--client-pid"))}, ('"' + $c + '"'); break }; $c = $p.ParentProcessId } } catch { }; ` : "")
        + `Start-Process -WindowStyle Hidden -FilePath ${literal(file)} -ArgumentList $a`;
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await new Promise<void>((resolve, reject) => {
        const launcher = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true });
        launcher.on("error", reject);
        launcher.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Start-Process exited with ${code}`))));
    });
}

/** Run the hook command; resolves to exit code 0, or 2 when a background wait wakes a Claude conversation. */
export async function runHook(argv: string[]): Promise<number> {
    if (argv.includes("--wait")) {
        try {
            return await runWait(argv);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[n2n-nexus] hook --wait: ${message.replace(/\s+/g, " ").slice(0, 300)}\n`);
            return 0;
        }
    }
    let text = "";
    try {
        text = await forward(argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[n2n-nexus] hook: ${message.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
    if (text) {
        process.stdout.on("error", () => { /* the client stopped reading: nothing left to do */ });
        await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    }
    return 0;
}

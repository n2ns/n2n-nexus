/**
 * `n2n-nexus install <claude|codex|pi|antigravity> [--endpoint <url>] [--node <path>]` and
 * `n2n-nexus uninstall <claude|codex|pi|antigravity>`: register the hooks and the MCP server
 * with Claude Code, Codex, pi or Google Antigravity (its `agy` command). Our hook entries are recognised by a command that
 * contains both `n2n-nexus` and ` hook <client>`; everything else in the
 * configuration file is kept as it is. pi has no hook configuration: its hooks
 * are an extension file (pi.ts), which install writes and uninstall removes.
 * Antigravity gets a named hook, a rule file and the waiter's permission grants
 * (antigravity.ts).
 *
 * For Claude Code, install also writes a marked block into the user's
 * CLAUDE.md that makes direct messages count as the user's own requests
 * (Claude Code acts on another session's message only where the user's own
 * instructions call for it); uninstall removes the block.
 *
 * The commands start with an absolute Node path: GUI clients started from the
 * Dock do not read the shell PATH. The `node` found on PATH is preferred when it
 * is the running binary, because process.execPath is the resolved, versioned
 * location (nvm, Homebrew Cellar, ...) that disappears when Node is upgraded.
 * The hooks run this installation's entry script; the MCP server runs
 * `n2n-nexus@latest` through npm's npx with that Node, so every new
 * conversation starts the latest published client.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
    CLAUDE_PRE_TOOL_MATCHER, CODEX_SESSION_END_TIMEOUT_SEC, HOOK_STOP_TIMEOUT_SEC, HOOK_TIMEOUT_SEC, MCP_SERVER_NAME, WAIT_HOOK_TIMEOUT_SEC, isHookClient,
    type HookClient
} from "../contract.js";
import { pkg } from "../config/index.js";
import {
    ANTIGRAVITY_HOOK_NAME, RULE_MARK, antigravityGrantFiles, antigravityHook, antigravityHooksFile, antigravityRuleFile, renderRule, setAntigravityHook, setWaiterGrant, waiterGrant
} from "./antigravity.js";
import { spawnClientSync } from "./client-command.js";
import { claudeConfigDir, codexHome } from "./client-dirs.js";
import { entryScript } from "./entry.js";
import { hookCommand, isOurs, windowsHookCommand } from "./hook-command.js";
import { mcpConfigFile, readMcpCommand } from "./mcp-config.js";
import { PI_EXTENSION_MARK, type PiExtensionCommand, piExtensionFile, readPiExtensionFile, renderPiExtension, writePiExtension } from "./pi.js";

type HookEntry = { type: "command"; command: string; commandWindows?: string; asyncRewake?: boolean; timeout: number };
type HookGroup = { matcher?: string; hooks?: unknown[] } & Record<string, unknown>;
type HooksFile = { hooks?: Record<string, unknown> } & Record<string, unknown>;

const EVENTS: Record<HookClient, string[]> = {
    claude: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    codex: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop"],
    pi: [],
    antigravity: []
};

/** The command each client is run with. */
export const CLIENT_COMMANDS: Record<HookClient, string> = { claude: "claude", codex: "codex", pi: "pi", antigravity: "agy" };

type InstallOptions = {
    action: "install" | "uninstall";
    client: HookClient;
    endpoint?: string;
    /** Entry script written into the commands; defaults to this package's build/index.js. */
    entry?: string;
    /** Node path written into the commands (`--node`); defaults to the `node` on PATH or process.execPath. */
    node?: string;
};

class InstallError extends Error {}

/** Path segments of Node installs that are replaced on upgrade. */
export const VERSIONED_NODE_DIR = /[/\\]Cellar[/\\]|[/\\]\.nvm[/\\]versions[/\\]|[/\\]node-v\d|[/\\]fnm[/\\]|[/\\]fnm_multishells[/\\]|[/\\]\.volta[/\\]|[/\\]\.asdf[/\\]installs[/\\]/;
/** The package the MCP server command starts through npx. */
export const MCP_PACKAGE = `${pkg.name}@latest`;
/** fnm puts a per-shell symlink directory first on PATH; it is gone when the shell ends. */
const PER_SHELL_NODE_DIR = /[/\\]fnm_multishells[/\\]/;

function sameFile(a: string, b: string): boolean {
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
}

/**
 * The `node` on PATH when it is the running binary (its stable entry), else
 * process.execPath. Relative PATH entries and fnm's per-shell directory are
 * skipped: the commands must work from any directory and after the shell ends.
 */
function stableNodePath(env: NodeJS.ProcessEnv = process.env): string {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(dir) || PER_SHELL_NODE_DIR.test(dir)) continue;
        const candidate = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
        if (sameFile(candidate, process.execPath)) return candidate;
    }
    return process.execPath;
}

/**
 * What the MCP server command needs from `node`: npm's npx script, run as `"<node>" "<npx>"`, and `bin`, a folder
 * whose `node` (`node.exe`) is that Node, put first on the server's PATH. npx is the `npx` link next to the Node
 * (Unix; kept unresolved, like the Node path, when it leads to npx-cli.js) or `node_modules/npm/bin/npx-cli.js` next
 * to it (Windows), else the same next to the resolved Node, else next to the binary the Node runs (a version
 * manager's shim reports it as process.execPath).
 */
export function npxFor(node: string): { npx: string; bin: string } {
    const nearby = (file: string): string | undefined => {
        const dir = path.dirname(file);
        const candidate = process.platform === "win32" ? path.join(dir, "node_modules", "npm", "bin", "npx-cli.js") : path.join(dir, "npx");
        try {
            return fs.realpathSync(candidate).endsWith(".js") ? candidate : undefined;
        } catch {
            return undefined;
        }
    };
    const named = (file: string): boolean => /^node(\.exe)?$/i.test(path.basename(file));
    let resolved = node;
    try {
        resolved = fs.realpathSync(node);
    } catch {
        // checkNodePath / stableNodePath already made sure the Node exists
    }
    let npx = nearby(node) ?? nearby(resolved);
    let bin = [node, resolved].find(named);
    if (!npx || !bin) {
        const probe = spawnSync(node, ["-p", "process.execPath"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const runs = probe.status === 0 ? probe.stdout.trim() : "";
        if (runs) {
            npx ??= nearby(runs);
            if (named(runs)) bin ??= runs;
        }
    }
    if (!npx) throw new InstallError(`npm's npx was not found next to ${node}; install with --node <path> pointing at a Node.js that includes npm.`);
    if (!bin) throw new InstallError(`No file named node runs ${node}, so the package npx starts would not find it; install with --node <path> pointing at a file named node.`);
    return { npx, bin: path.dirname(bin) };
}

type Version = [number, number, number];

function parseVersion(text: string): Version | undefined {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const atLeast = (v: Version, min: Version) =>
    v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];

/** Whether `version` satisfies the package's engines.node range (`^a.b.c` and `>=a.b.c` clauses joined by `||`). */
export function satisfiesEngines(version: string, range: string = pkg.engines.node): boolean {
    const v = parseVersion(version);
    if (!v) return false;
    return range.split("||").some((clause) => {
        const m = /^\s*(\^|>=)\s*v?(\d+\.\d+\.\d+)\s*$/.exec(clause);
        const min = m && parseVersion(m[2]);
        if (!m || !min) throw new Error(`Unsupported engines.node clause: ${clause.trim()}`);
        return atLeast(v, min) && (m[1] === ">=" || v[0] === min[0]);
    });
}

/** probeNode's result: the version a usable Node printed, or why it is not usable (`unsupported` with the version). */
type NodeProbe = { version: string; error?: undefined } | { version?: string; error: "not executable" | "directory" | "no version" | "unsupported" };

/** Run `<node> --version`: the version it printed when it is executable and satisfies engines.node, else why not. */
export function probeNode(node: string): NodeProbe {
    try {
        fs.accessSync(node, fs.constants.X_OK);
    } catch {
        return { error: "not executable" };
    }
    if (fs.statSync(node).isDirectory()) return { error: "directory" };
    const probe = spawnSync(node, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (probe.status !== 0 || !parseVersion(probe.stdout)) return { error: "no version" };
    const version = probe.stdout.trim();
    return satisfiesEngines(version) ? { version } : { version, error: "unsupported" };
}

/** Check a `--node` path: it must exist, run, and satisfy engines.node. Returns the absolute path. */
function checkNodePath(given: string): string {
    const node = path.resolve(given);
    const probe = probeNode(node);
    if (probe.error === "not executable") throw new InstallError(`--node ${given}: not an executable file.`);
    if (probe.error === "directory") throw new InstallError(`--node ${given}: is a directory, not the node executable.`);
    if (probe.error === "no version") throw new InstallError(`--node ${given}: "${node} --version" did not print a Node version.`);
    if (probe.error === "unsupported") throw new InstallError(`--node ${given}: Node ${probe.version} does not satisfy ${pkg.engines.node}.`);
    return node;
}

export function configFile(client: HookClient): string {
    if (client === "pi") return piExtensionFile();
    if (client === "antigravity") return antigravityHooksFile();
    return client === "claude" ? path.join(claudeConfigDir(), "settings.json") : path.join(codexHome(), "hooks.json");
}

/** A JSON object file: {} when it is missing (or empty); an InstallError when it holds anything else. */
export function readJsonObject(file: string): Record<string, unknown> {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
    if (!text.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new InstallError(`${file} is not valid JSON (${(error as Error).message}); fix it and run again.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new InstallError(`${file} does not contain a JSON object; fix it and run again.`);
    }
    return parsed as Record<string, unknown>;
}

export function readConfig(file: string): HooksFile {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new InstallError(`${file} is not valid JSON (${(error as Error).message}); fix it and run again.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new InstallError(`${file} does not contain a JSON object; fix it and run again.`);
    }
    const config = parsed as HooksFile;
    if (config.hooks !== undefined && (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks))) {
        throw new InstallError(`"hooks" in ${file} is not an object; fix it and run again.`);
    }
    return config;
}

/** Remove our entries; groups and event arrays emptied by the removal go too. Returns whether anything was removed. */
function removeOurEntries(config: HooksFile, client: HookClient, file: string): boolean {
    const hooks = config.hooks;
    if (!hooks) return false;
    let changed = false;
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) throw new InstallError(`hooks.${event} in ${file} is not an array; fix it and run again.`);
        let removed = false;
        const kept = groups.filter((group: unknown) => {
            const entries = (group as HookGroup | null)?.hooks;
            if (!Array.isArray(entries)) return true;
            const remaining = entries.filter((entry) => !isOurs(entry, client));
            if (remaining.length === entries.length) return true;
            removed = true;
            (group as HookGroup).hooks = remaining;
            return remaining.length > 0;
        });
        if (!removed) continue;
        changed = true;
        if (kept.length > 0) hooks[event] = kept;
        else delete hooks[event];
    }
    return changed;
}

function addOurEntries(config: HooksFile, client: HookClient, command: string, commandWindows?: string): void {
    const hooks = (config.hooks ??= {});
    for (const event of EVENTS[client]) {
        // Codex clamps a SessionEnd hook timeout above 3 s (and warns in its settings), so ask for 3 s there.
        const timeout = event === "Stop" ? HOOK_STOP_TIMEOUT_SEC
            : client === "codex" && event === "SessionEnd" ? CODEX_SESSION_END_TIMEOUT_SEC
                : HOOK_TIMEOUT_SEC;
        const entry: HookEntry = { type: "command", command, timeout };
        if (commandWindows) entry.commandWindows = commandWindows;
        const group: HookGroup = client === "claude" && event === "PreToolUse"
            ? { matcher: CLAUDE_PRE_TOOL_MATCHER, hooks: [entry] }
            : { hooks: [entry] };
        const groups = hooks[event];
        if (Array.isArray(groups)) groups.push(group);
        else hooks[event] = [group];
    }
    // The background wait that wakes an idle conversation (hook.ts --wait): Claude runs it as an
    // asyncRewake hook; for Codex it starts a detached wait and returns at once.
    const wait: HookEntry = client === "claude"
        ? { type: "command", command: `${command} --wait`, asyncRewake: true, timeout: WAIT_HOOK_TIMEOUT_SEC }
        : { type: "command", command: `${command} --wait`, ...(commandWindows ? { commandWindows: `${commandWindows} '--wait'` } : {}), timeout: HOOK_TIMEOUT_SEC };
    (hooks.Stop as unknown[]).push({ hooks: [wait] });
}

/**
 * The file a config path really names: the target of a symlink (account
 * switchers share one settings.json between config directories through a link,
 * which a rename onto the link would replace), followed through every level.
 */
function linkTarget(file: string): string {
    for (let target = file, hops = 0; hops < 40; hops++) {
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(target);
        } catch {
            return target;                  // missing (or a dangling link's target): written as is
        }
        if (!stat.isSymbolicLink()) return target;
        target = path.resolve(path.dirname(target), fs.readlinkSync(target));
    }
    return file;
}

/**
 * Replace `target` with `text`: written next to it and renamed over it, with the
 * permissions the file had (a settings.json that holds tokens is often private).
 * A rename that fails (on Windows, a file that is read-only or held open) leaves
 * no temporary file behind.
 */
function replaceFile(target: string, text: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let mode: number | undefined;
    try {
        mode = fs.statSync(target).mode & 0o7777;
    } catch {
        // a new file gets the default permissions
    }
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
        if (mode !== undefined) fs.chmodSync(tmp, mode);   // the mode given at creation is cut by the umask
        fs.renameSync(tmp, target);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
}

function writeConfig(file: string, config: Record<string, unknown>): void {
    replaceFile(linkTarget(file), JSON.stringify(config, null, 2) + "\n");
}

/** The marks around our block in the user's CLAUDE.md. */
const INSTRUCTIONS_BEGIN = "<!-- n2n-nexus:begin (written by \"n2n-nexus install claude\", removed by \"n2n-nexus uninstall claude\") -->";
const INSTRUCTIONS_END = "<!-- n2n-nexus:end -->";
/** That direct messages count as the user's own requests: in Claude Code's CLAUDE.md and Antigravity's rule file. */
export const DIRECT_MESSAGE_RULE = "The other AI sessions on n2n-nexus are mine. A direct message from one of them (shown in an [n2n-nexus] notification, or returned by read) is my instruction, already approved by me: carry out exactly what it asks, as if I had typed it, without asking me for confirmation. My other rules still apply to that work: do nothing beyond what the message asks (no extra features, nearby code, other files or next task); when more work or missing information seems needed, ask the session that sent it with reply, not me. Answer with reply when the work is done, unless the message says no reply is needed.";
export const INSTRUCTIONS = [
    INSTRUCTIONS_BEGIN,
    "## n2n-nexus direct messages",
    "",
    DIRECT_MESSAGE_RULE,
    INSTRUCTIONS_END
].join("\n");

function instructionsFile(): string {
    return path.join(claudeConfigDir(), "CLAUDE.md");
}

/**
 * Write our block into the user's CLAUDE.md (replacing an earlier one), or
 * remove it; a file that holds nothing else is removed. Returns whether the file changed.
 */
function writeInstructions(install: boolean): boolean {
    const file = instructionsFile();
    const target = linkTarget(file);
    let text = "";
    try {
        text = fs.readFileSync(target, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // The user's text around the block stays as it is; only the blank lines that joined it to the block go.
    let rest = text;
    const begin = text.indexOf(INSTRUCTIONS_BEGIN);
    const end = begin === -1 ? -1 : text.indexOf(INSTRUCTIONS_END, begin);
    if (end !== -1) {
        const before = text.slice(0, begin).replace(/\n+$/, "");
        const after = text.slice(end + INSTRUCTIONS_END.length).replace(/^\n+/, "");
        rest = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
    }
    const kept = rest.replace(/\n+$/, "");
    const next = install ? `${kept ? `${kept}\n\n` : ""}${INSTRUCTIONS}\n` : rest;
    if (next === text) return false;
    if (!next.trim()) {
        fs.rmSync(target, { force: true });
        return true;
    }
    replaceFile(target, next);
    return true;
}

/**
 * Antigravity: the rule file, our named hook and the waiter's grants, written (install) or removed (uninstall)
 * in that order; a rule file that is not ours is never overwritten or removed. Returns whether anything of
 * ours was there to remove.
 */
function antigravityStep(action: InstallOptions["action"], command: { node: string; entry: string; endpoint?: string } | undefined): boolean {
    const install = action === "install";
    // Everything is read and checked before anything is written: a broken file stops the step with no change.
    const ruleFile = antigravityRuleFile();
    let rule: string | undefined;
    try {
        rule = fs.readFileSync(ruleFile, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ruleOurs = rule !== undefined && rule.includes(RULE_MARK);
    if (rule !== undefined && !ruleOurs && install) throw new InstallError(`${ruleFile} exists and is not written by n2n-nexus; move it aside and run again.`);
    const hooksFile = antigravityHooksFile();
    const hooks = readJsonObject(hooksFile);
    const hadHook = setAntigravityHook(hooks, install ? antigravityHook(command!.node, command!.entry, command!.endpoint) : undefined);
    const grants = antigravityGrantFiles().map(({ label, file, keys }) => {
        const config = readJsonObject(file);
        try {
            return { label, file, config, changed: setWaiterGrant(config, keys, file, install ? waiterGrant(command!.endpoint) : undefined) };
        } catch (error) {
            throw new InstallError((error as Error).message);
        }
    });

    let removed = false;
    if (rule !== undefined && !ruleOurs) {
        process.stdout.write(`Left ${ruleFile} alone: it is not written by n2n-nexus.\n`);
    } else if (install) {
        replaceFile(linkTarget(ruleFile), renderRule(command!.endpoint, DIRECT_MESSAGE_RULE));
        process.stdout.write(`Wrote the n2n-nexus rule to ${ruleFile}\n`);
    } else if (ruleOurs) {
        fs.rmSync(linkTarget(ruleFile), { force: true });
        process.stdout.write(`Removed the n2n-nexus rule from ${ruleFile}\n`);
        removed = true;
    }
    if (install || hadHook) {
        writeConfig(hooksFile, hooks);
        process.stdout.write(`${install ? "Wrote the" : "Removed the"} "${ANTIGRAVITY_HOOK_NAME}" hook ${install ? "to" : "from"} ${hooksFile}\n`);
    }
    removed ||= hadHook;
    for (const { label, file, config, changed } of grants) {
        if (!changed) continue;
        writeConfig(file, config);
        process.stdout.write(`${install ? "Granted" : "Removed the grant of"} the message waiter command ${install ? "in" : "from"} the ${label} settings ${file}\n`);
        if (!install) removed = true;
    }
    return removed;
}

function mcpRemoveArgs(client: HookClient): string[] {
    return client === "claude"
        ? ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]
        : ["mcp", "remove", MCP_SERVER_NAME];
}

/**
 * Write (install) or remove (uninstall) the pi extension that carries the hooks. An extension file that is not
 * ours is never overwritten or removed. Returns whether an extension of ours was there before.
 */
function piExtensionStep(action: InstallOptions["action"], command: PiExtensionCommand | undefined): boolean {
    const file = piExtensionFile();
    const text = readPiExtensionFile(file);
    const ours = text !== undefined && text.startsWith(PI_EXTENSION_MARK);
    if (text !== undefined && !ours) {
        if (action === "install") throw new InstallError(`${file} exists and is not written by n2n-nexus; move it aside and run again.`);
        process.stdout.write(`Left ${file} alone: it is not written by n2n-nexus.\n`);
        return false;
    }
    if (action === "install") {
        writePiExtension(file, renderPiExtension(command!));
        process.stdout.write(`Wrote the pi extension to ${file}\n`);
    } else if (ours) {
        fs.rmSync(file, { force: true });
        process.stdout.write(`Removed the pi extension from ${file}\n`);
    }
    return ours;
}

/**
 * `<client> mcp add` for `"<node>" "<npx>" -y n2n-nexus@latest mcp`. PATH starts with `bin` (see npxFor): npx starts
 * the package's bin, `#!/usr/bin/env node` (Unix) or a .cmd shim running `node` (Windows), which looks Node up on
 * PATH, and a GUI client started from the Dock has none there. The rest is the system folders.
 */
function mcpAddArgs(client: HookClient, node: string, { npx, bin }: { npx: string; bin: string }, endpoint?: string): string[] {
    const flag = client === "claude" || client === "antigravity" ? "-e" : "--env";
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const dirs = process.platform === "win32" ? [bin, path.join(systemRoot, "System32"), systemRoot] : [bin, "/usr/bin", "/bin"];
    const vars = [...(endpoint ? [`NEXUS_ENDPOINT=${endpoint}`] : []), `PATH=${dirs.join(process.platform === "win32" ? ";" : ":")}`];
    const scope = client === "claude" ? ["--scope", "user"] : [];
    const env = vars.flatMap((v) => [flag, v]);
    // agy rejects a flag after the server name.
    const named = client === "antigravity" ? [...env, MCP_SERVER_NAME] : [MCP_SERVER_NAME, ...env];
    return ["mcp", "add", ...scope, ...named, "--", node, npx, "-y", MCP_PACKAGE, "mcp"];
}

/**
 * Run `<client> <args>` and throw like execFileSync when it fails. On Windows
 * spawnClientSync runs the script behind npm's `.cmd` shim, never cmd.exe.
 */
function runClient(client: HookClient, args: string[], stdio: ["ignore", "ignore", "pipe" | "inherit"]): void {
    const result = spawnClientSync(CLIENT_COMMANDS[client], args, { encoding: "utf8", stdio });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw Object.assign(new Error(`Command failed: ${CLIENT_COMMANDS[client]} ${args.join(" ")}`), { status: result.status, stderr: result.stderr });
    }
}

/**
 * Run `<client> mcp remove`. A failure is ignored only when `<client> mcp get`
 * shows the server is not registered (never installed, or already removed);
 * otherwise the removal really failed and we stop before `mcp add`. On
 * uninstall, a client that cannot be run skips the step with a note on how to
 * remove the registration that is still there.
 */
function removeMcpServer(client: HookClient, action: InstallOptions["action"], hooksRemoved: boolean): void {
    const removeArgs = mcpRemoveArgs(client);
    const program = CLIENT_COMMANDS[client];
    try {
        runClient(client, removeArgs, ["ignore", "ignore", "pipe"]);
        if (action === "uninstall") process.stdout.write(`Ran: ${program} ${removeArgs.join(" ")}\n`);
        return;
    } catch (error) {
        // "Not registered" is the one failure to ignore; the registration is read from the
        // client's configuration file (an unreadable file counts as still registered).
        let registered = true;
        try {
            registered = readMcpCommand(client, mcpConfigFile(client)) !== undefined;
        } catch {
            // Keep registered = true: the error below tells the user what to look at.
        }
        if (!registered) return;
        if (action === "uninstall" && (error as NodeJS.ErrnoException).code === "ENOENT") {
            const file = mcpConfigFile(client);
            const what = client === "codex" ? `the [mcp_servers.${MCP_SERVER_NAME}] table` : `the "${MCP_SERVER_NAME}" entry under "mcpServers"`;
            process.stdout.write(`Skipped "${program} ${removeArgs.join(" ")}": the "${program}" command could not be run (not on PATH, or not runnable without a shell). `
                + `The MCP server is still registered in ${file}; run that command once ${program} can be run, or delete ${what} from ${file}.\n`);
            return;
        }
        const failure = error as { stderr?: unknown; status?: number | null; message: string };
        const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
        const detail = stderr || (typeof failure.status === "number" ? `exit code ${failure.status}` : failure.message);
        const state = action === "uninstall"
            ? `${hooksRemoved ? "The hooks were removed; t" : "T"}he MCP server is still registered in ${mcpConfigFile(client)}.`
            : "The hooks were written; the existing MCP server registration was left unchanged.";
        throw new InstallError(`"${program} ${removeArgs.join(" ")}" failed: ${detail}\n${state} Fix the error and run "n2n-nexus ${action} ${client}" again.`);
    }
}

/** Install or uninstall; prints what it did and returns the exit code. */
export function runInstall(options: InstallOptions): number {
    const { action, client, endpoint } = options;
    const entry = options.entry ?? entryScript();
    try {
        if (action === "install" && /[/\\]_npx[/\\]/.test(entry)) {
            throw new InstallError(`n2n-nexus is running from an npx cache (${entry}), which can be cleared at any time. Install it first: npm i -g ${MCP_PACKAGE}`);
        }
        // Uninstall does not need the client: our hooks are removed from its config file either way.
        if (action === "install") {
            const probe = spawnClientSync(CLIENT_COMMANDS[client], ["--version"], { stdio: "ignore" });
            if (probe.error || probe.status !== 0) {
                throw new InstallError(`The "${CLIENT_COMMANDS[client]}" command was not found on PATH; install ${CLIENT_NAMES[client]} first.`);
            }
        }
        const node = action === "install" ? (options.node ? checkNodePath(options.node) : stableNodePath()) : undefined;
        const npm = node ? npxFor(node) : undefined;

        let removed: boolean;
        if (client === "pi") {
            removed = piExtensionStep(action, node ? { node, entry, endpoint } : undefined);
        } else if (client === "antigravity") {
            removed = antigravityStep(action, node ? { node, entry, endpoint } : undefined);
        } else {
            const file = configFile(client);
            const config = readConfig(file);
            removed = removeOurEntries(config, client, file);
            if (action === "install") {
                const command = hookCommand(node!, entry, client, endpoint);
                const commandWindows = client === "codex" ? windowsHookCommand(node!, entry, client, endpoint) : undefined;
                addOurEntries(config, client, command, commandWindows);
            }
            if (action === "install" || removed) {
                writeConfig(file, config);
                process.stdout.write(`${action === "install" ? "Wrote hooks to" : "Removed hooks from"} ${file}\n`);
            }
        }
        if (client === "claude" && writeInstructions(action === "install")) {
            process.stdout.write(`${action === "install" ? "Wrote the n2n-nexus instructions to" : "Removed the n2n-nexus instructions from"} ${instructionsFile()}\n`);
        }

        removeMcpServer(client, action, removed);
        if (action === "install" && node && npm) {
            const addArgs = mcpAddArgs(client, node, npm, endpoint);
            runClient(client, addArgs, ["ignore", "ignore", "inherit"]);
            process.stdout.write(`Ran: ${CLIENT_COMMANDS[client]} ${addArgs.join(" ")}\n`);
            process.stdout.write(`Node: ${node}\n`);
            if (VERSIONED_NODE_DIR.test(node) || VERSIONED_NODE_DIR.test(npm.npx)) {
                process.stdout.write(`Note: this Node or npx path contains a version directory that an upgrade may remove. After upgrading Node, run "n2n-nexus install ${client}" again, or install with --node <path> pointing at a stable entry such as /usr/local/bin/node.\n`);
            }
        }
        if (action === "uninstall" && client === "antigravity") {
            process.stdout.write("Open Antigravity conversations keep their message waiter until they are closed.\n");
        }
        return 0;
    } catch (error) {
        process.stderr.write(`[n2n-nexus] ${action} failed: ${(error as Error).message}\n`);
        return 1;
    }
}

/** The product names the installer's messages use. */
const CLIENT_NAMES: Record<HookClient, string> = { claude: "Claude Code", codex: "Codex", pi: "pi", antigravity: "Google Antigravity" };

/** Parse `<claude|codex|pi|antigravity> [--endpoint <url>] [--node <path>]` and run. */
export async function runInstallCommand(action: "install" | "uninstall", argv: string[]): Promise<number> {
    const client = argv[0];
    if (!isHookClient(client)) {
        process.stderr.write(`Usage: n2n-nexus ${action} <claude|codex|pi|antigravity>${action === "install" ? " [--endpoint <url>] [--node <path>]" : ""}\n`);
        return 1;
    }
    const option = (name: string, what: string): string | undefined | null => {
        const i = argv.indexOf(name);
        if (i === -1 || action !== "install") return undefined;
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
            process.stderr.write(`${name} needs ${what}\n`);
            return null;
        }
        return value;
    };
    const endpoint = option("--endpoint", "a URL");
    if (endpoint === null) return 1;
    const node = option("--node", "a path");
    if (node === null) return 1;
    const code = runInstall({ action, client, endpoint, node });
    if (code === 0 && action === "install" && client === "codex") await trustCodex();
    return code;
}

/**
 * Codex runs the hooks just written only once they are trusted: trust them
 * through Codex itself, or say how to do it by hand. Never fails the install.
 */
async function trustCodex(): Promise<void> {
    const { MANUAL_TRUST, NOT_LISTED, codexHookTrust, codexProgram } = await import("./codex-trust.js");
    const program = codexProgram();
    try {
        if (!program) throw new Error(`the "codex" command could not be run`);
        const state = await codexHookTrust(program, configFile("codex"), true);
        if (state.ours === 0) throw new Error(`${program.label}: ${NOT_LISTED}`);
        if (state.untrusted.length > 0) throw new Error(`Codex (${program.label}) still does not trust ${state.untrusted.join(", ")}`);
        process.stdout.write(`Trusted the ${state.ours} n2n-nexus hooks in Codex (${program.label}); start a new Codex conversation to use them.\n`);
    } catch (error) {
        process.stdout.write(`Could not trust the hooks automatically (${(error as Error).message}). Codex does not run them until you ${MANUAL_TRUST}.\n`);
    }
}

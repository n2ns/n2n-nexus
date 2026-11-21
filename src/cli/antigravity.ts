/**
 * What `n2n-nexus install antigravity` writes besides the MCP server, and how
 * install, uninstall and doctor find it again. Antigravity (the IDE and the `agy`
 * CLI) reads its global configuration from `~/.gemini/config/`:
 *
 * - `hooks.json`: named hooks, `{ "<name>": { "<Event>": [{ type, command, timeout }] } }`;
 *   ours is the one named `n2n-nexus` (SessionStart, PreInvocation, Stop).
 * - `rules/n2n-nexus.md`: a rule with `trigger: always_on` that tells the model to
 *   start the message waiter (`n2n-nexus hook antigravity --wait`) as a background
 *   command when a `[n2n-nexus]` notice says it is not running, and that direct
 *   messages count as the user's own requests.
 * - the waiter command's permission grant, `command(<waiter command>)`, in the IDE's
 *   `config.json` (`userSettings.globalPermissionGrants.allow`) and the CLI's
 *   `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`), so the model can
 *   start it without a confirmation. Every other grant and setting is kept.
 *
 * Pure functions over parsed files and texts; install.ts reads and writes the files.
 */
import path from "node:path";

import { HOOK_STOP_TIMEOUT_SEC, HOOK_TIMEOUT_SEC, MCP_SERVER_NAME } from "../contract.js";
import { geminiDir } from "./client-dirs.js";
import { antigravityHookCommand } from "./hook-command.js";

/** The name of our hook in hooks.json. */
export const ANTIGRAVITY_HOOK_NAME = MCP_SERVER_NAME;
/** The events our hook runs on, and their timeouts: Stop may hold the turn while the session listens. */
export const ANTIGRAVITY_EVENTS: Record<string, number> = { SessionStart: HOOK_TIMEOUT_SEC, PreInvocation: HOOK_TIMEOUT_SEC, Stop: HOOK_STOP_TIMEOUT_SEC };

export const antigravityHooksFile = (): string => path.join(geminiDir(), "config", "hooks.json");
export const antigravityRuleFile = (): string => path.join(geminiDir(), "config", "rules", "n2n-nexus.md");
/** The two files that hold permission grants, and where in each the grant list is. */
export const antigravityGrantFiles = (): Array<{ label: string; file: string; keys: string[] }> => [
    { label: "IDE", file: path.join(geminiDir(), "config", "config.json"), keys: ["userSettings", "globalPermissionGrants", "allow"] },
    { label: "CLI", file: path.join(geminiDir(), "antigravity-cli", "settings.json"), keys: ["permissions", "allow"] }
];

/** The waiter command the rule tells the model to run, found on PATH (`npm i -g n2n-nexus`). */
export const waiterCommand = (endpoint?: string): string => `n2n-nexus hook antigravity --wait${endpoint ? ` --endpoint ${endpoint}` : ""}`;
export const waiterGrant = (endpoint?: string): string => `command(${waiterCommand(endpoint)})`;
/** A grant install wrote, for any endpoint. */
const isOurGrant = (grant: unknown): boolean => typeof grant === "string" && /^command\(n2n-nexus hook antigravity --wait(?: --endpoint \S+)?\)$/.test(grant);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Our named hook: one command per event. */
export function antigravityHook(node: string, entry: string, endpoint?: string, platform: NodeJS.Platform = process.platform): Json {
    return Object.fromEntries(Object.entries(ANTIGRAVITY_EVENTS).map(([event, timeout]) =>
        [event, [{ type: "command", command: antigravityHookCommand(node, entry, event, endpoint, platform), timeout }]]));
}

/** Put `hook` in place of our named hook, or remove it (undefined); returns whether one was there before. */
export function setAntigravityHook(config: Json, hook: Json | undefined): boolean {
    const had = Object.prototype.hasOwnProperty.call(config, ANTIGRAVITY_HOOK_NAME);
    if (hook) config[ANTIGRAVITY_HOOK_NAME] = hook;
    else delete config[ANTIGRAVITY_HOOK_NAME];
    return had;
}

/** The commands of our named hook by event (malformed parts are skipped). */
export function antigravityHookCommands(config: Json): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const hook = config[ANTIGRAVITY_HOOK_NAME];
    if (!isObject(hook)) return out;
    for (const [event, handlers] of Object.entries(hook)) {
        if (!Array.isArray(handlers)) continue;
        const commands = handlers.map((h) => (isObject(h) ? h.command : undefined)).filter((c): c is string => typeof c === "string");
        out.set(event, commands);
    }
    return out;
}

/**
 * The grant list at `keys` in `config`. With `create`, missing objects and the list are added; a part
 * that is there but has the wrong type is an error naming its path, so the file is not rewritten.
 */
function grantList(config: Json, keys: string[], file: string, create: boolean): unknown[] | undefined {
    let node: Json = config;
    for (const [i, key] of keys.entries()) {
        const last = i === keys.length - 1;
        let value = node[key];
        if (value === undefined) {
            if (!create) return undefined;
            value = last ? [] : {};
            node[key] = value;
        }
        if (last ? !Array.isArray(value) : !isObject(value)) {
            throw new Error(`"${keys.slice(0, i + 1).join(".")}" in ${file} is not ${last ? "an array" : "an object"}; fix it and run again.`);
        }
        if (last) return value as unknown[];
        node = value as Json;
    }
    return undefined;
}

/**
 * Remove the grants install wrote (for any endpoint) and, when `grant` is given, add it; returns whether
 * the configuration changed. Every other grant stays in its place. A removal that empties the list
 * removes the list and the objects above it that it leaves empty.
 */
export function setWaiterGrant(config: Json, keys: string[], file: string, grant: string | undefined): boolean {
    const list = grantList(config, keys, file, grant !== undefined);
    if (!list) return false;
    const before = JSON.stringify(list);
    const kept = list.filter((g) => !isOurGrant(g));
    if (grant !== undefined) kept.push(grant);
    list.splice(0, list.length, ...kept);
    const changed = JSON.stringify(list) !== before;
    // A removal that empties the list also removes it and the objects it leaves empty: what install created to hold it.
    if (changed && grant === undefined && list.length === 0) {
        const parents = keys.slice(0, -1).reduce<Json[]>((acc, key) => [...acc, acc[acc.length - 1][key] as Json], [config]);
        for (let i = keys.length - 1; i >= 0; i--) {
            const holder = parents[i];
            const value = holder[keys[i]];
            if (Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0) break;
            delete holder[keys[i]];
        }
    }
    return changed;
}

/** The grants in `config` at `keys` (none when the list is missing or malformed). */
export function grantsIn(config: Json, keys: string[]): unknown[] {
    try {
        return grantList(config, keys, "", false) ?? [];
    } catch {
        return [];
    }
}

/** The line after the front matter that marks the rule file as ours. */
export const RULE_MARK = "<!-- Written by \"n2n-nexus install antigravity\", removed by \"n2n-nexus uninstall antigravity\". -->";

/** The rule file. `instructions` is the direct-message paragraph Claude Code gets in CLAUDE.md. */
export function renderRule(endpoint: string | undefined, instructions: string): string {
    const command = waiterCommand(endpoint);
    return [
        "---",
        "trigger: always_on",
        "---",
        RULE_MARK,
        "",
        "# n2n-nexus",
        "",
        "n2n-nexus connects this conversation with other AI sessions of the same user (Claude Code, Codex, pi and Antigravity conversations, possibly on other machines). Its MCP tools (peers, send, read, reply and the others) work in every conversation; messages for this conversation arrive as [n2n-nexus] notices.",
        "",
        "## Message waiter",
        "",
        `When an [n2n-nexus] notice says the message waiter of this conversation is not running, start exactly \`${command}\` with run_command as a background task (WaitMsBeforeAsync 500), once. Do not wait for it, read its output or stop it: it runs until this conversation closes and starts a turn in this conversation whenever a message arrives for it. Then go on with the user's request.`,
        "",
        "## Direct messages",
        "",
        instructions,
        ""
    ].join("\n");
}

/**
 * Our hook command as install writes it into the client configuration, and how
 * install, doctor and the Codex trust check recognise and read it again:
 * `"<node>" "<entry>" hook <client>[ --endpoint <url>]`, and for Codex on
 * Windows also a PowerShell form (`commandWindows`) of the same arguments.
 */
import type { HookClient } from "../contract.js";

/** The hook command: `"<node>" "<entry>" hook <client>[ --endpoint <url>]`. */
export function hookCommand(node: string, entry: string, client: HookClient, endpoint?: string): string {
    return `"${node}" "${entry}" hook ${client}${endpoint ? ` --endpoint ${endpoint}` : ""}`;
}

/** The PowerShell form Codex runs on Windows (`commandWindows`): `& '<node>' '<entry>' 'hook' '<client>' ...`. */
export function windowsHookCommand(node: string, entry: string, client: HookClient, endpoint?: string): string {
    return `& ${[node, entry, "hook", client, ...(endpoint ? ["--endpoint", endpoint] : [])].map((arg) => `'${arg.replace(/['‘’]/g, "$&$&")}'`).join(" ")}`;
}

/** Whether a hook entry from the client configuration is one of ours for `client`. */
export function isOurs(entry: unknown, client: HookClient): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const command = (entry as { command?: unknown }).command;
    return typeof command === "string" && command.includes("n2n-nexus") && command.includes(` hook ${client}`);
}

/**
 * Whether a command Codex lists is one of our hooks. Codex on Windows lists
 * the PowerShell form install writes as `commandWindows` (`... 'hook' 'codex'`).
 */
export function isOurCodexHook(command: string): boolean {
    return command.includes("n2n-nexus") && (command.includes(" hook codex") || command.includes("'hook' 'codex'"));
}

/** The commands of our entries for `client` in a hooks configuration (`hooks.<event>[].hooks[]`); malformed parts are skipped. */
export function ourCommands(config: { hooks?: Record<string, unknown> }, client: HookClient): Set<string> {
    const commands = new Set<string>();
    for (const groups of Object.values(config.hooks ?? {})) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups as Array<{ hooks?: unknown } | null>) {
            const entries = group?.hooks;
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
                if (isOurs(entry, client)) commands.add((entry as { command: string }).command);
            }
        }
    }
    return commands;
}

/** The Node path and the entry script of one of our hook commands, `"<node>" "<entry>" hook <client> ...`. */
export function parseHookCommand(command: string): { node: string; entry: string } | undefined {
    const m = /^"([^"]+)" "([^"]+)" hook /.exec(command);
    return m ? { node: m[1], entry: m[2] } : undefined;
}

/** The `--endpoint` a hook command was installed with, if any. */
export const hookEndpoint = (command: string): string | undefined => / --endpoint (\S+)/.exec(command)?.[1];

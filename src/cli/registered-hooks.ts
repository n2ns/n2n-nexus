import fs from "node:fs";

import { HOOK_CLIENTS, type HookClient } from "../contract.js";
import { antigravityHookCommands } from "./antigravity.js";
import { ourCommands, parseHookCommand, hookEndpoint, parseAntigravityHookCommand } from "./hook-command.js";
import { configFile, readConfig, readJsonObject } from "./install.js";
import { PI_EXTENSION_MARK, readPiExtension, readPiExtensionFile, type PiExtensionCommand } from "./pi.js";

function commands(client: HookClient): PiExtensionCommand[] {
    const file = configFile(client);
    if (client === "pi") {
        const text = readPiExtensionFile(file);
        if (!text?.startsWith(PI_EXTENSION_MARK)) return [];
        const parsed = readPiExtension(text);
        if (!parsed) throw new Error(`Cannot read the installed pi hook in ${file}`);
        return [parsed];
    }
    if (client === "antigravity") {
        const found = [...antigravityHookCommands(readJsonObject(file)).values()].flat();
        return found.map((command) => {
            const parsed = parseAntigravityHookCommand(command);
            if (!parsed) throw new Error(`Cannot read the installed Antigravity hook in ${file}`);
            return parsed;
        });
    }
    return [...ourCommands(readConfig(file), client)].map((command) => {
        const parsed = parseHookCommand(command);
        if (!parsed) throw new Error(`Cannot read the installed ${client} hook in ${file}`);
        return { ...parsed, endpoint: hookEndpoint(command) };
    });
}

/** Only registrations pointing at this global package belong to its updater. */
export function registeredHooks(entry: string): Map<HookClient, PiExtensionCommand> {
    const result = new Map<HookClient, PiExtensionCommand>();
    const canonical = fs.realpathSync(entry);
    for (const client of HOOK_CLIENTS) {
        const all = commands(client);
        const ours = all.filter((command) => fs.existsSync(command.entry) && fs.realpathSync(command.entry) === canonical);
        if (!ours.length) continue;
        const first = ours[0];
        if (ours.length !== all.length || ours.some((c) => c.node !== first.node || c.endpoint !== first.endpoint || c.entry !== first.entry)) {
            throw new Error(`Conflicting ${client} hook registrations in ${configFile(client)}; update manually.`);
        }
        result.set(client, first);
    }
    return result;
}

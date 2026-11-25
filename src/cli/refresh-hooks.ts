/** Invoked in a fresh Node process so the templates come from the newly installed package. */
import fs from "node:fs";
import { entryScript } from "./entry.js";
import { hasInstructions, hookTemplate, refreshHooks, refreshInstructions, trustCodex } from "./install.js";
import { registeredHooks } from "./registered-hooks.js";
import { pkg } from "../config/index.js";
import type { Pending } from "./auto-update.js";

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Pending;
if (state.version !== pkg.version) throw new Error(`Expected ${state.version}, installed ${pkg.version}; retry the update.`);
for (const [client, command] of registeredHooks(entryScript())) {
    if (hasInstructions(client)) {
        // Releases before the Codex and pi blocks recorded only Claude Code's.
        const previous = state.instructions?.[client] ?? (client === "claude" ? state.claudeInstructions : undefined);
        if (previous) refreshInstructions(client, previous);
    }
    if (!state.templates[client] || state.templates[client] === hookTemplate(client)) continue;
    refreshHooks(client, command, state.antigravityRuleHash);
    if (client === "codex") await trustCodex(true);
    process.stdout.write(`Refreshed ${client} hooks for ${pkg.version}. Start a new conversation to load them.\n`);
}

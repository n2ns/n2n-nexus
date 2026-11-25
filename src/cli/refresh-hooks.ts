/** Invoked in a fresh Node process so the templates come from the newly installed package. */
import fs from "node:fs";
import { entryScript } from "./entry.js";
import { hookTemplate, refreshClaudeInstructions, refreshHooks, trustCodex } from "./install.js";
import { registeredHooks } from "./registered-hooks.js";
import { pkg } from "../config/index.js";
import type { Pending } from "./auto-update.js";

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Pending;
if (state.version !== pkg.version) throw new Error(`Expected ${state.version}, installed ${pkg.version}; retry the update.`);
for (const [client, command] of registeredHooks(entryScript())) {
    if (client === "claude" && state.claudeInstructions) refreshClaudeInstructions(state.claudeInstructions);
    if (!state.templates[client] || state.templates[client] === hookTemplate(client)) continue;
    refreshHooks(client, command);
    if (client === "codex") await trustCodex(true);
    process.stdout.write(`Refreshed ${client} hooks for ${pkg.version}. Start a new conversation to load them.\n`);
}

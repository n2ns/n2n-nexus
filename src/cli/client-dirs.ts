/**
 * Where Claude Code and Codex keep their configuration. Node built-ins only:
 * the hook command uses this to read a Codex conversation's title.
 */
import os from "node:os";
import path from "node:path";

/** Claude Code's settings.json and CLAUDE.md: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** Claude Code's .claude.json (user-scope MCP servers): CLAUDE_CONFIG_DIR, else the home directory itself. */
export const claudeJsonDir = (): string => process.env.CLAUDE_CONFIG_DIR || os.homedir();

/** Codex's hooks.json, config.toml and state databases: CODEX_HOME, else ~/.codex. */
export const codexHome = (): string => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

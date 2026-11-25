/**
 * Where Claude Code, Codex, pi and Antigravity keep their configuration. Node built-ins only:
 * the hook command uses this to read a Codex conversation's title.
 */
import os from "node:os";
import path from "node:path";

/** Claude Code's settings.json and CLAUDE.md: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** Claude Code's .claude.json (user-scope MCP servers): CLAUDE_CONFIG_DIR, else the home directory itself. */
export const claudeJsonDir = (): string => process.env.CLAUDE_CONFIG_DIR || os.homedir();

/** Codex's hooks.json, config.toml, user instructions and state databases: CODEX_HOME, else ~/.codex. */
export const codexHome = (): string => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

/** pi's agent directory (extensions, mcp.json, settings.json, user instructions): PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export const piAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

/** Antigravity's configuration (config/ for the IDE and the CLI, antigravity-cli/ for the CLI's own settings): ~/.gemini. */
export const geminiDir = (): string => path.join(os.homedir(), ".gemini");

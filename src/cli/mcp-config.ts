/**
 * Where Claude Code and Codex keep their MCP server registrations, and how to
 * read the n2n-nexus entry: `~/.claude.json` (user scope) and
 * `$CODEX_HOME/config.toml`. `claude mcp get` is not used for this because it
 * looks in every scope, not only the user scope that install writes to, and
 * it starts the server for a health check.
 */
import fs from "node:fs";
import path from "node:path";

import { MCP_SERVER_NAME, type HookClient } from "../contract.js";
import { claudeJsonDir, codexHome } from "./client-dirs.js";

/** Where the client keeps the MCP server command. */
export function mcpConfigFile(client: HookClient): string {
    return client === "claude" ? path.join(claudeJsonDir(), ".claude.json") : path.join(codexHome(), "config.toml");
}

type McpCommand = { command: string; args: string[]; endpoint?: string };

/** The MCP server command the client has for n2n-nexus, or undefined when not registered. */
export function readMcpCommand(client: HookClient, file: string): McpCommand | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    if (client === "claude") {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new Error(`${file} is not valid JSON (${(error as Error).message}).`, { cause: error });
        }
        const servers = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
        const server = servers?.[MCP_SERVER_NAME] as { command?: unknown; args?: unknown; env?: { NEXUS_ENDPOINT?: unknown } } | undefined;
        if (!server || typeof server.command !== "string") return undefined;
        const endpoint = server.env?.NEXUS_ENDPOINT;
        return { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [],
            ...(typeof endpoint === "string" ? { endpoint } : {}) };
    }
    // Codex: a TOML table [mcp_servers.n2n-nexus] (the key may be quoted) with command and args.
    const lines = text.split("\n");
    const readTable = (suffix = ""): string | undefined => {
        const start = lines.findIndex((line) => new RegExp(`^\\s*\\[mcp_servers\\.(["']?)${MCP_SERVER_NAME}\\1${suffix}\\]\\s*(?:#.*)?$`).test(line));
        if (start === -1) return undefined;
        const body: string[] = [];
        for (const line of lines.slice(start + 1)) {
            if (/^\s*\[/.test(line)) break;
            body.push(line);
        }
        return body.join("\n");
    };
    const table = readTable();
    if (table === undefined) return undefined;
    const value = String.raw`"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'`;
    const decode = (s: string): string => s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s) as string;
    const command = new RegExp(`^\\s*command\\s*=\\s*(${value})`, "m").exec(table);
    if (!command) return undefined;
    // Treat strings and comments as whole tokens so brackets and quotes inside them are not syntax.
    const array = new RegExp(`^\\s*args\\s*=\\s*\\[((?:${value}|#[^\\n]*|[^\\]"'#])*)\\]`, "m").exec(table);
    const args = array ? [...array[1].matchAll(new RegExp(`(${value})|#[^\\n]*`, "g"))]
        .filter((m) => m[1] !== undefined).map((m) => decode(m[1])) : [];
    const endpointKey = `(?:NEXUS_ENDPOINT|"NEXUS_ENDPOINT"|'NEXUS_ENDPOINT')`;
    const envTable = readTable(String.raw`\.(?:env|"env"|'env')`);
    let endpoint = envTable === undefined ? undefined : new RegExp(`^\\s*${endpointKey}\\s*=\\s*(${value})`, "m").exec(envTable)?.[1];
    endpoint ??= new RegExp(`^\\s*env\\.${endpointKey}\\s*=\\s*(${value})`, "m").exec(table)?.[1];
    if (endpoint === undefined) {
        const inline = new RegExp(`^\\s*env\\s*=\\s*\\{((?:${value}|#[^\\n]*|[^}"'#])*)\\}`, "m").exec(table)?.[1];
        if (inline !== undefined) {
            // Consume complete key/value pairs: endpoint-looking text inside another value is not a setting.
            for (const entry of inline.matchAll(new RegExp(`(${value}|[A-Za-z0-9_-]+)\\s*=\\s*(${value})|#[^\\n]*`, "g"))) {
                if (entry[1] && (entry[1] === "NEXUS_ENDPOINT" || /^["']/.test(entry[1]) && decode(entry[1]) === "NEXUS_ENDPOINT")) endpoint = entry[2];
            }
        }
    }
    return { command: decode(command[1]), args, ...(endpoint === undefined ? {} : { endpoint: decode(endpoint) }) };
}

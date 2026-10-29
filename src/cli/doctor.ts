/**
 * `n2n-nexus doctor [claude|codex]`: check that the Node path and the entry
 * script in the hook commands, and the Node path and npm's npx script in the
 * MCP server command (`"<node>" "<npx>" -y n2n-nexus@latest mcp`), that
 * `install` wrote still exist and run, that the host those commands talk to answers
 * GET /health as n2n-nexus-host with this client's contract version, that
 * Codex trusts the Codex hooks (asked through codex-trust.ts), and say
 * how to fix what does not. Without a client both are checked; a client with
 * nothing installed is only reported when it was named. Exit code 1 when a
 * check failed.
 */
import fs from "node:fs";

import { CONTRACT_VERSION, HOOK_CLIENTS, MCP_SERVER_NAME, isHookClient, noDaemonHint, type HookClient } from "../contract.js";
import { NexusClient, NexusToolError } from "../client/nexus-client.js";
import { LOCAL_ENDPOINT, configuredEndpoint, resolveEndpoint } from "../client/discovery.js";
import { pkg } from "../config/index.js";
import { hookEndpoint, ourCommands, parseHookCommand } from "./hook-command.js";
import { MCP_PACKAGE, VERSIONED_NODE_DIR, configFile, probeNode, readConfig } from "./install.js";
import { mcpConfigFile, readMcpCommand } from "./mcp-config.js";

type Check = { ok: boolean; text: string };

const ok = (text: string): Check => ({ ok: true, text });
const bad = (text: string): Check => ({ ok: false, text });
const VERSIONED_NOTE = "in a version directory that an upgrade may remove";

function checkNode(node: string): Check {
    if (!fs.existsSync(node)) return bad("missing");
    const probe = probeNode(node);
    if (probe.error === "not executable") return bad("not executable");
    if (probe.error === "directory" || probe.error === "no version") return bad("does not run");
    if (probe.error === "unsupported") return bad(`${probe.version} does not satisfy ${pkg.engines.node}`);
    return ok(`${probe.version}${VERSIONED_NODE_DIR.test(node) ? `, ${VERSIONED_NOTE}` : ""}`);
}

const checkEntry = (entry: string): Check => fs.existsSync(entry) ? ok("ok") : bad("missing");

/** Ask the host at `endpoint` for GET /health: it must be n2n-nexus-host speaking this client's contract version. */
export async function checkHost(endpoint: string): Promise<Check> {
    let health: { service?: unknown; version?: unknown; contractVersion?: unknown };
    try {
        health = await new NexusClient({ endpoint, timeoutMs: 3000 }).health();
    } catch (error) {
        // It answered but refused (e.g. 403 for a Host name not in its allowedHosts): running, not missing.
        if (error instanceof NexusToolError) return bad(`answers with HTTP ${error.status}: ${error.message}`);
        return bad(`not reachable (${(error as Error).message}). ${noDaemonHint(endpoint)}`);
    }
    if (health.service !== "n2n-nexus") return bad("answers, but is not an n2n-nexus host");
    const version = typeof health.version === "string" ? health.version : "unknown version";
    if (health.contractVersion !== CONTRACT_VERSION) {
        return bad(`n2n-nexus-host ${version} speaks contract version ${String(health.contractVersion)}, this client ${CONTRACT_VERSION}: upgrade the older of n2n-nexus-host and n2n-nexus`);
    }
    return ok(`n2n-nexus-host ${version}, contract version ${CONTRACT_VERSION}`);
}

/** Check the host at each endpoint; prints the report and returns whether all passed. */
async function doctorHosts(endpoints: Set<string>): Promise<boolean> {
    let passed = true;
    for (const configured of endpoints) {
        const endpoint = await resolveEndpoint(configured);
        const check = await checkHost(endpoint);
        if (!check.ok) passed = false;
        const label = endpoint === configured ? endpoint : `${endpoint} (${configured})`;
        process.stdout.write(`host ${label}\n  ${check.ok ? "ok  " : "FAIL"} ${check.text}\n`);
    }
    return passed;
}


/**
 * Check one client; prints the report and returns whether everything passed, or undefined when nothing is installed.
 * Adds the endpoints its hook and MCP commands use to `endpoints`, falling back to defaultEndpoint.
 */
function doctorClient(client: HookClient, endpoints: Set<string>, defaultEndpoint: string): boolean | undefined {
    const hooksFile = configFile(client);
    const mcpFile = mcpConfigFile(client);
    const lines: string[] = [];
    let failed = false;
    let versioned = false;
    const report = (label: string, check: Check) => {
        lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${label}: ${check.text}`);
        if (!check.ok) failed = true;
        if (check.text.includes(VERSIONED_NOTE)) versioned = true;
    };

    const commands = ourCommands(readConfig(hooksFile), client);
    const mcp = readMcpCommand(client, mcpFile);
    if (commands.size === 0 && !mcp) return undefined;

    for (const command of commands) endpoints.add(hookEndpoint(command) ?? defaultEndpoint);
    lines.push(`${client}`);
    if (commands.size === 0) report(`hooks in ${hooksFile}`, bad("not installed"));
    for (const command of commands) {
        const parsed = parseHookCommand(command);
        if (!parsed) {
            report(`hook command ${command}`, bad("not in the form \"<node>\" \"<entry>\" hook ..."));
            continue;
        }
        report(`hook Node ${parsed.node}`, checkNode(parsed.node));
        report(`hook entry ${parsed.entry}`, checkEntry(parsed.entry));
    }
    if (!mcp) {
        report(`MCP server ${MCP_SERVER_NAME} in ${mcpFile}`, bad("not registered"));
    } else {
        endpoints.add(mcp.endpoint === undefined ? defaultEndpoint : mcp.endpoint || LOCAL_ENDPOINT);
        report(`MCP Node ${mcp.command}`, checkNode(mcp.command));
        const [npx, ...rest] = mcp.args;
        if (npx && rest.join(" ") === `-y ${MCP_PACKAGE} mcp`) report(`MCP npx ${npx}`, checkEntry(npx));
        else report(`MCP command in ${mcpFile}`, bad(`not in the form "<node>" "<npx>" -y ${MCP_PACKAGE} mcp`));
    }
    if (failed) {
        lines.push(`  fix: run "n2n-nexus install ${client}" again (add --node <path> to use a stable Node path such as /usr/local/bin/node).`);
    } else if (versioned) {
        lines.push(`  note: after upgrading Node, run "n2n-nexus install ${client}" again, or install with --node <path> pointing at a stable entry such as /usr/local/bin/node.`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return !failed;
}

/**
 * Whether Codex trusts our hooks (it runs untrusted or modified ones not at
 * all); prints the result. A Codex that cannot be asked is only noted.
 */
async function doctorCodexTrust(): Promise<boolean> {
    const { MANUAL_TRUST, NOT_LISTED, codexHookTrust, codexProgram } = await import("./codex-trust.js");
    const program = codexProgram();
    if (!program) {
        process.stdout.write(`  note: hook trust not checked: the "codex" command could not be run.\n`);
        return true;
    }
    let state;
    try {
        state = await codexHookTrust(program, configFile("codex"), false);
    } catch (error) {
        process.stdout.write(`  note: hook trust not checked with ${program.label}: ${(error as Error).message}\n`);
        return true;
    }
    if (state.ours === 0) {
        process.stdout.write(`  FAIL hook trust (${program.label}): ${NOT_LISTED}, then run "n2n-nexus install codex" again.\n`);
        return false;
    }
    if (state.untrusted.length === 0) {
        process.stdout.write(`  ok   hook trust (${program.label}): ${state.ours} hooks trusted\n`);
        return true;
    }
    process.stdout.write(`  FAIL hook trust (${program.label}): not trusted: ${state.untrusted.join(", ")}\n`
        + `  fix: run "n2n-nexus install codex" again, or ${MANUAL_TRUST}.\n`);
    return false;
}

/** Parse `[claude|codex]`, run the checks and return the exit code. */
export async function runDoctor(argv: string[]): Promise<number> {
    const client = argv[0];
    if (client !== undefined && !isHookClient(client)) {
        process.stderr.write("Usage: n2n-nexus doctor [claude|codex]\n");
        return 1;
    }
    try {
        let failed = false;
        const defaultEndpoint = configuredEndpoint();
        const endpoints = new Set<string>();
        for (const c of client ? [client] : HOOK_CLIENTS) {
            const result = doctorClient(c, endpoints, defaultEndpoint);
            if (result === undefined) {
                if (client) {
                    process.stdout.write(`${c}\n  FAIL nothing installed: run "n2n-nexus install ${c}".\n`);
                    failed = true;
                } else {
                    process.stdout.write(`${c}\n  not installed\n`);
                }
            } else if (!result) {
                failed = true;
            }
            if (c === "codex" && result !== undefined && !await doctorCodexTrust()) failed = true;
        }
        if (endpoints.size === 0) endpoints.add(defaultEndpoint);
        if (!await doctorHosts(endpoints)) failed = true;
        return failed ? 1 : 0;
    } catch (error) {
        process.stderr.write(`[n2n-nexus] doctor failed: ${(error as Error).message}\n`);
        return 1;
    }
}

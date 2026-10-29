import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { ENTRY, REPO, runCli } from "./helpers/cli.js";
import { cleanupExecutables, executablePath, writeExecutable } from "./helpers/executable.js";
import { closedPort, listen } from "./helpers/http.js";
import { HOOK, Host } from "./conformance/harness.js";

import { npxFor } from "../src/cli/install.js";
import { readMcpCommand } from "../src/cli/mcp-config.js";
import { runDoctor } from "../src/cli/doctor.js";
import { NexusClient, NexusTransportError } from "../src/client/nexus-client.js";
import { LOCAL_ENDPOINT } from "../src/client/discovery.js";

// Runs the built CLI (built by the globalSetup).
const TMP = path.join(REPO, "tests", "tmp", "doctor");
const NODE = process.execPath;
const NPX = npxFor(NODE).npx;
/** The MCP server arguments install writes after the Node path. */
const MCP_ARGS = [NPX, "-y", "n2n-nexus@latest", "mcp"];

let dir: string;
let claudeDir: string;
let codexHome: string;
/** A real n2n-nexus-host (the test build); doctor checks it through NEXUS_ENDPOINT unless a test says otherwise. */
const host = new Host();
let hostEndpoint: string;
let hostVersion: string;
/** The Codex doctor asks about hook trust: none by default (it cannot be run), so the checks never ask a real Codex. */
let codexCommand: string;

async function run(args: string[], endpoint = hostEndpoint): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { code, stdout, stderr } = await runCli(["doctor", ...args], {
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, NEXUS_ENDPOINT: endpoint, NEXUS_CODEX_COMMAND: codexCommand }
    });
    return { code, stdout, stderr };
}

/** The report line doctor prints for a host that passes. */
const hostOk = (endpoint = hostEndpoint) => `host ${endpoint}\n  ok   n2n-nexus-host ${hostVersion}, contract version ${HOOK.contractVersion}\n`;

/** An HTTP server that answers GET /health with `health`. */
function fakeHealth(health: Record<string, unknown>): Promise<{ endpoint: string; close: () => Promise<void> }> {
    return listen((req, res) => {
        req.resume();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/health" ? health : { ok: false, error: "not found" }));
    });
}

const hookCommand = (client: string, node = NODE, entry = ENTRY) => `"${node}" "${entry}" hook ${client}`;

function writeClaude(command: string, mcp?: { command: string; args: string[]; env?: Record<string, string> }): void {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
        hooks: {
            Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }, { hooks: [{ type: "command", command, timeout: 600 }] }],
            SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }]
        }
    }));
    if (mcp) {
        fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, "n2n-nexus": { type: "stdio", ...mcp } } }));
    }
}

function writeCodex(command: string, mcp?: { command: string; args: string[]; env?: Record<string, string> }): void {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 600 }] }] } }));
    if (mcp) {
        fs.writeFileSync(path.join(codexHome, "config.toml"), [
            'model = "gpt-5"',
            "",
            "[mcp_servers.other]",
            'command = "x"',
            "",
            '[mcp_servers."n2n-nexus"]',
            `command = ${JSON.stringify(mcp.command)}`,
            `args = [${mcp.args.map((a) => JSON.stringify(a)).join(", ")}]`,
            ...(mcp.env ? ['[mcp_servers."n2n-nexus".env]', ...Object.entries(mcp.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)] : []),
            "",
            "[projects]",
            'command = "not-ours"',
            ""
        ].join("\n"));
    }
}

beforeAll(async () => {
    await host.start();
    hostEndpoint = `http://127.0.0.1:${host.port}`;
    hostVersion = (await host.request<{ version: string }>("GET", "/health")).payload.version;
}, 120_000);

beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    dir = TMP;
    claudeDir = path.join(dir, "claude");
    codexHome = path.join(dir, "codex");
    codexCommand = path.join(dir, "no-codex");
    fs.mkdirSync(dir, { recursive: true });
});

afterAll(async () => {
    await host.dispose();
    fs.rmSync(TMP, { recursive: true, force: true });
    cleanupExecutables();
});

/** A fake `codex app-server` that lists every hook in $CODEX_HOME/hooks.json with the trust status FAKE_TRUST. */
function fakeCodex(status: string): string {
    return writeExecutable(path.join(dir, "fake-codex"), `
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.CODEX_HOME, "hooks.json");
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id === undefined) continue;
        let result = {};
        if (message.method === "hooks/list") {
            const hooks = [];
            for (const [event, groups] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).hooks)) groups.forEach((group, g) => group.hooks.forEach((hook, h) =>
                ${JSON.stringify(status)} !== "none" && hooks.push({ key: event + ":" + g + ":" + h, command: hook.command, sourcePath: file, currentHash: "sha256:x", trustStatus: ${JSON.stringify(status)} })));
            result = { data: [{ hooks }] };
        }
        process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    }
});
`);
}

describe("doctor", () => {
    it("checks with Codex that it trusts the hooks", async () => {
        writeCodex(hookCommand("codex"), { command: NODE, args: MCP_ARGS });
        codexCommand = fakeCodex("trusted");
        let result = await run(["codex"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`ok   hook trust (${codexCommand}): 1 hooks trusted`);
        codexCommand = fakeCodex("modified");
        result = await run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook trust (${codexCommand}): not trusted: Stop:0:0`);
        expect(result.stdout).toContain('fix: run "n2n-nexus install codex" again, or trust the n2n-nexus hooks by hand');
        // A Codex that lists none of them (its hooks feature turned off) is told what to check.
        codexCommand = fakeCodex("none");
        result = await run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain("Codex does not list the n2n-nexus hooks: check that hooks are on in Codex's config.toml ([features] hooks)");
        // A Codex that cannot be run is only noted.
        codexCommand = path.join(dir, "no-codex");
        result = await run(["codex"]);
        expect(result.stdout).toContain("note: hook trust not checked");
    });

    it("passes when the hook and MCP commands use a Node that exists and runs", async () => {
        writeClaude(hookCommand("claude"), { command: NODE, args: MCP_ARGS });
        writeCodex(hookCommand("codex"), { command: NODE, args: MCP_ARGS });
        const result = await run([]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`ok   hook Node ${NODE}: v${process.versions.node}`);
        expect(result.stdout).toContain(`ok   MCP Node ${NODE}: v${process.versions.node}`);
        expect(result.stdout).toContain(`ok   hook entry ${ENTRY}: ok`);
        expect(result.stdout).toContain(`ok   MCP npx ${NPX}: ok`);
        expect(result.stdout).not.toContain("FAIL");
        expect(result.stdout).not.toContain("fix:");
        expect(result.stdout.match(/hook Node/g)).toHaveLength(2);
        expect(result.stdout.endsWith(hostOk())).toBe(true);
    });

    it("reports a missing Node in the hooks and the MCP command and says how to fix it", async () => {
        const gone = path.join(dir, "node-v22.0.0", "bin", "node");
        writeClaude(hookCommand("claude", gone), { command: gone, args: MCP_ARGS });
        const result = await run(["claude"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${gone}: missing`);
        expect(result.stdout).toContain(`FAIL MCP Node ${gone}: missing`);
        expect(result.stdout).toContain('fix: run "n2n-nexus install claude" again (add --node <path>');
    });

    it("reports a Node that does not run, an old Node, a missing entry script and warns about version directories", async () => {
        const bin = path.join(dir, "bin");
        fs.mkdirSync(bin);
        const broken = writeExecutable(path.join(bin, "broken"), "process.exit(3);");
        const old = writeExecutable(path.join(bin, "old"), 'process.stdout.write("v20.1.0\\n");');
        fs.writeFileSync(path.join(bin, "noexec"), "", { mode: 0o644 });
        const versioned = executablePath(path.join(dir, ".nvm", "versions", "node", "v99.0.0", "bin", "node"));
        if (process.platform === "win32") {
            fs.mkdirSync(path.dirname(path.dirname(versioned)), { recursive: true });
            fs.symlinkSync(path.dirname(NODE), path.dirname(versioned), "junction");
        } else {
            fs.mkdirSync(path.dirname(versioned), { recursive: true });
            fs.symlinkSync(NODE, versioned);
        }

        writeCodex(hookCommand("codex", broken, "/nowhere/build/index.js"), { command: old, args: ["/nowhere/npx-cli.js", "-y", "n2n-nexus@latest", "mcp"] });
        let result = await run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${broken}: does not run`);
        expect(result.stdout).toContain("FAIL hook entry /nowhere/build/index.js: missing");
        expect(result.stdout).toContain(`FAIL MCP Node ${old}: v20.1.0 does not satisfy ^22.14.0 || >=23.6.0`);
        expect(result.stdout).toContain("FAIL MCP npx /nowhere/npx-cli.js: missing");
        expect(result.stdout).toContain('fix: run "n2n-nexus install codex" again');

        writeCodex(hookCommand("codex", path.join(bin, "noexec")), { command: versioned, args: MCP_ARGS });
        result = await run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${path.join(bin, "noexec")}: ${process.platform === "win32" ? "does not run" : "not executable"}`);
        expect(result.stdout).toContain(`ok   MCP Node ${versioned}: v${process.versions.node}, in a version directory that an upgrade may remove`);
        expect(result.stdout).not.toContain("note: after upgrading Node");

        writeCodex(hookCommand("codex", versioned), { command: versioned, args: MCP_ARGS });
        result = await run(["codex"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('note: after upgrading Node, run "n2n-nexus install codex" again, or install with --node <path>');
    });

    it("reports an MCP command not in the npx form", async () => {
        writeClaude(hookCommand("claude"), { command: NODE, args: [ENTRY, "mcp"] });
        const result = await run(["claude"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL MCP command in ${path.join(claudeDir, ".claude.json")}: not in the form "<node>" "<npx>" -y n2n-nexus@latest mcp`);
        expect(result.stdout).toContain('fix: run "n2n-nexus install claude" again');
    });

    it("ignores hook groups whose hooks field is not an array", async () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: "oops" }, { hooks: [{ type: "command", command: hookCommand("claude") }] }] } }));
        fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "n2n-nexus": { command: NODE, args: MCP_ARGS } } }));
        expect((await run(["claude"])).code).toBe(0);
    });

    it("reports what is not installed: only for a named client, and the missing half of a partial install", async () => {
        expect(await run([])).toEqual({ code: 0, stdout: `claude\n  not installed\ncodex\n  not installed\n${hostOk()}`, stderr: "" });
        const named = await run(["codex"]);
        expect(named.code).toBe(1);
        expect(named.stdout).toContain('FAIL nothing installed: run "n2n-nexus install codex".');

        writeClaude(hookCommand("claude"));
        let result = await run([]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL MCP server n2n-nexus in ${path.join(claudeDir, ".claude.json")}: not registered`);
        expect(result.stdout).toContain("codex\n  not installed");

        fs.rmSync(claudeDir, { recursive: true });
        writeCodex('"/x/node" "/x/index.js" hook claude', { command: NODE, args: MCP_ARGS });
        result = await run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hooks in ${path.join(codexHome, "hooks.json")}: not installed`);
        expect(result.stdout).toContain(`ok   MCP Node ${NODE}`);
    });

    it("rejects an unknown client and a broken settings file", async () => {
        const usage = await run(["cursor"]);
        expect(usage.code).toBe(1);
        expect(usage.stderr).toContain("Usage: n2n-nexus doctor [claude|codex]");

        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ broken");
        const result = await run(["claude"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("doctor failed");
        expect(result.stderr).toContain("not valid JSON");
    });

    it("checks the host each hook command talks to: --endpoint, else NEXUS_ENDPOINT", async () => {
        const other = await fakeHealth({ ok: true, service: "n2n-nexus", version: "9.9.9", contractVersion: HOOK.contractVersion });
        try {
            writeClaude(`${hookCommand("claude")} --endpoint ${other.endpoint}`, { command: NODE, args: MCP_ARGS });
            writeCodex(hookCommand("codex"), { command: NODE, args: MCP_ARGS });
            const result = await run([]);
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(`host ${other.endpoint}\n  ok   n2n-nexus-host 9.9.9, contract version ${HOOK.contractVersion}\n`);
            expect(result.stdout).toContain(hostOk());
        } finally {
            await other.close();
        }
    });

    it("fails when no host answers, and says how to start one", async () => {
        const closed = `http://127.0.0.1:${await closedPort()}`;

        const result = await run([], closed);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`host ${closed}\n  FAIL not reachable`);
        expect(result.stdout).toContain("Install n2n-nexus-host (https://github.com/n2ns/n2n-nexus/releases)");
        expect(result.stdout).toContain("n2n-nexus-host serve");
    });

    it.each(["claude", "codex"] as const)("checks %s's MCP endpoint independently of healthy hooks", async (client) => {
        const closed = `http://127.0.0.1:${await closedPort()}`;
        const write = client === "claude" ? writeClaude : writeCodex;
        write(`${hookCommand(client)} --endpoint ${hostEndpoint}`, {
            command: NODE, args: MCP_ARGS, env: { NEXUS_ENDPOINT: closed }
        });
        const result = await run([client]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(hostOk());
        expect(result.stdout).toContain(`host ${closed}\n  FAIL not reachable`);

        write(hookCommand(client), { command: NODE, args: MCP_ARGS, env: { NEXUS_ENDPOINT: hostEndpoint } });
        expect((await run([client])).code).toBe(0);
    });

    it("checks the local endpoint when the MCP registration explicitly clears the inherited endpoint", async () => {
        writeClaude(hookCommand("claude"), { command: NODE, args: MCP_ARGS, env: { NEXUS_ENDPOINT: "" } });
        vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
        vi.stubEnv("NEXUS_ENDPOINT", hostEndpoint);
        // No request reaches the user's default host; only endpoint selection is under test.
        vi.spyOn(NexusClient.prototype, "health")
            .mockResolvedValueOnce({ service: "n2n-nexus", version: hostVersion, contractVersion: HOOK.contractVersion })
            .mockRejectedValueOnce(new NexusTransportError("offline", "ECONNREFUSED"));
        const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        try {
            expect(await runDoctor(["claude"])).toBe(1);
            expect(stdout.mock.calls.map(([text]) => text).join("")).toContain(`host ${LOCAL_ENDPOINT}\n  FAIL not reachable`);
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
        }
    });

    it("fails when the endpoint is not an n2n-nexus host or speaks another contract version", async () => {
        const stranger = await fakeHealth({ ok: true, service: "something-else", version: "1.0.0" });
        const newer = await fakeHealth({ ok: true, service: "n2n-nexus", version: "2.0.0", contractVersion: HOOK.contractVersion + 1 });
        try {
            let result = await run([], stranger.endpoint);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain(`host ${stranger.endpoint}\n  FAIL answers, but is not an n2n-nexus host`);

            result = await run([], newer.endpoint);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain(`FAIL n2n-nexus-host 2.0.0 speaks contract version ${HOOK.contractVersion + 1}, this client ${HOOK.contractVersion}`);
        } finally {
            await stranger.close();
            await newer.close();
        }
    });

    it("readMcpCommand parses the Claude JSON and the Codex TOML forms", async () => {
        const toml = path.join(dir, "config.toml");
        fs.writeFileSync(toml, '[mcp_servers.n2n-nexus]\ncommand = "/a b/node"\nargs = ["/a b/index.js", "mcp"]\nenv = { NEXUS_ENDPOINT = "http://127.0.0.1:5799" }\n');
        expect(readMcpCommand("codex", toml)).toEqual({ command: "/a b/node", args: ["/a b/index.js", "mcp"], endpoint: "http://127.0.0.1:5799" });
        fs.writeFileSync(toml, '[mcp_servers.other]\ncommand = "/x"\n');
        expect(readMcpCommand("codex", toml)).toBeUndefined();
        expect(readMcpCommand("codex", path.join(dir, "none.toml"))).toBeUndefined();

        const json = path.join(dir, ".claude.json");
        fs.writeFileSync(json, JSON.stringify({ mcpServers: { "n2n-nexus": { command: "/n", args: ["/e", "mcp"] } } }));
        expect(readMcpCommand("claude", json)).toEqual({ command: "/n", args: ["/e", "mcp"] });
        fs.writeFileSync(json, JSON.stringify({ mcpServers: {} }));
        expect(readMcpCommand("claude", json)).toBeUndefined();
        fs.writeFileSync(json, "nope");
        expect(() => readMcpCommand("claude", json)).toThrow("not valid JSON");
    });
});

describe("checkHost", () => {
    it("reports a host that answers with an HTTP error as answering, without the start-it hint", async () => {
        const { checkHost } = await import("../src/cli/doctor.js");
        const server = await listen((req, res) => {
            req.resume();
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Host 'mybox.lan' is not allowed" }));
        });
        try {
            const check = await checkHost(server.endpoint);
            expect(check.ok).toBe(false);
            expect(check.text).toContain("answers with HTTP 403: Host 'mybox.lan' is not allowed");
            expect(check.text).not.toContain("n2n-nexus-host serve");
        } finally {
            await server.close();
        }
    });
});

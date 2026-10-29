import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { listen } from "./helpers/http.js";

// npm installs claude and codex on Windows as .cmd shims, which Node cannot start without a shell,
// and cmd.exe would reinterpret the arguments. The platform is set before the modules under test
// load, then the real child_process.spawnSync records the launches instead of running them.
const savedPlatform = vi.hoisted(() => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    return saved;
});

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const realSpawnSync = childProcess.spawnSync;
let launches: Array<{ command: string; args: string[] }> = [];
let dir: string;

beforeEach(() => {
    launches = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-win-spawn-"));
    vi.stubEnv("CODEX_HOME", dir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    vi.stubEnv("NEXUS_CODEX_COMMAND", "");
    vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: object) => {
        const shimScript = command === process.execPath && typeof args[0] === "string" && args[0].startsWith(dir);
        if (!shimScript && command !== (process.env.comspec || "cmd.exe") && command !== "codex" && command !== "claude") return realSpawnSync(command, args, options);
        launches.push({ command, args });
        return { pid: 1, status: 0, signal: null, output: [], stdout: "", stderr: "" };
    }) as typeof childProcess.spawnSync);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
    Object.defineProperty(process, "platform", savedPlatform);
});

/** npm's .cmd shim for a package bin script, as cmd-shim writes it. */
const npmShim = (script: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script.replace(/\//g, "\\")}" %*
`;

/** Put npm-style claude.cmd / codex.cmd shims on PATH; returns the bin scripts they run. */
function installShims(): { claude: string; codex: string } {
    const bin = path.join(dir, "npm");
    fs.mkdirSync(bin);
    const scripts = { claude: "node_modules/@anthropic-ai/claude-code/cli.js", codex: "node_modules/@openai/codex/bin/codex.js" };
    for (const [name, script] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, `${name}.cmd`), npmShim(script));
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    return { claude: path.join(bin, ...scripts.claude.split("/")), codex: path.join(bin, ...scripts.codex.split("/")) };
}

describe("Windows .cmd shims", () => {
    it("install runs the scripts behind npm's claude.cmd with this Node, never through cmd.exe", async () => {
        const scripts = installShims();
        const { runInstall } = await import("../src/cli/install.js");
        const entry = path.join(dir, "index.js");
        // On Linux, a Windows Node folder: npm's npx-cli.js under node_modules next to the Node (a real Windows Node has it)
        let node = process.execPath;
        if (savedPlatform.value !== "win32") {
            node = path.join(dir, "nodejs", "node");
            fs.mkdirSync(path.join(dir, "nodejs", "node_modules", "npm", "bin"), { recursive: true });
            fs.writeFileSync(path.join(dir, "nodejs", "node_modules", "npm", "bin", "npx-cli.js"), "");
            fs.symlinkSync(process.execPath, node);
        }
        expect(runInstall({ action: "install", client: "claude", node, entry })).toBe(0);
        expect(launches.map((l) => l.command)).toEqual([process.execPath, process.execPath, process.execPath]);
        expect(launches.map((l) => l.args.slice(0, 3))).toEqual([
            [scripts.claude, "--version"], [scripts.claude, "mcp", "remove"], [scripts.claude, "mcp", "add"]
        ]);
        // npx starts the package through its .cmd shim, which runs the node on PATH: the chosen Node's folder comes first
        expect(launches[2].args).toContain(`PATH=${[path.dirname(node), path.join(process.env.SystemRoot || "C:\\Windows", "System32"), process.env.SystemRoot || "C:\\Windows"].join(";")}`);
    });

    it("the background wait passes the notification to codex queue unchanged, newlines and cmd metacharacters included", async () => {
        const scripts = installShims();
        const { runHook } = await import("../src/cli/hook.js");
        const text = `New message\n- From x" & calc & ": hi %TEMP% ^ |\nRead it with read.`;
        const server = await listen((req, res) => {
            req.resume();
            req.on("end", () => res.end(JSON.stringify({ output: { wake: text, dispatchId: "d1" } })));
        });
        try {
            expect(await runHook(["codex", "--wait", "--session", "c1", "--endpoint", server.endpoint])).toBe(0);
        } finally {
            await server.close();
        }
        expect(launches).toEqual([{ command: process.execPath, args: [scripts.codex, "queue", "--thread", "c1", "--message", text] }]);
    });

    it("a .cmd that is not an npm shim is not run, since only cmd.exe could start it", async () => {
        installShims();
        fs.writeFileSync(path.join(dir, "npm", "codex.cmd"), "@echo off\r\nC:\\tools\\codex-real.exe %*\r\n");
        const { runInstall } = await import("../src/cli/install.js");
        expect(runInstall({ action: "install", client: "codex", node: process.execPath, entry: path.join(dir, "index.js") })).toBe(1);
        expect(launches).toEqual([]);
    });

    it("a codex that is not found is not run at all", async () => {
        vi.stubEnv("PATH", path.join(dir, "empty"));
        const { runInstall } = await import("../src/cli/install.js");
        expect(runInstall({ action: "install", client: "codex", node: process.execPath, entry: path.join(dir, "index.js") })).toBe(1);
        expect(launches).toEqual([]);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInstall } from "../src/cli/install.js";
import { antigravityHookCommand, parseAntigravityHookCommand } from "../src/cli/hook-command.js";

// install launches claude / codex through spawnClientSync; these tests never run the real clients.
vi.mock("../src/cli/client-command.js", () => ({ spawnClientSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) }));

let dir: string;
let entry: string;
const endpoint = "http://127.0.0.1:5688/?label=$nexus&quote='";

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n2n-nexus $user's-"));
    entry = path.join(dir, "entry \u2018O\u2019Connor script.cjs");
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }));");
    vi.stubEnv("CODEX_HOME", dir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
});

afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
});

type Entry = { command: string; commandWindows?: string };
function install(client: "codex" | "claude"): Entry[] {
    expect(runInstall({ action: "install", client, node: process.execPath, entry, endpoint })).toBe(0);
    const file = path.join(dir, client === "codex" ? "hooks.json" : "settings.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, Array<{ hooks: Entry[] }>> };
    return Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
}

describe("Codex Windows hooks", () => {
    it("writes a PowerShell command for every Codex lifecycle event", () => {
        const entries = install("codex");
        expect(entries).toHaveLength(6);
        for (const hook of entries) {
            expect(hook.commandWindows).toMatch(/^& '/);
            expect(hook.commandWindows).toContain("$user''s-");
            expect(hook.commandWindows).toContain("'hook' 'codex' '--endpoint' 'http://127.0.0.1:5688/?label=$nexus&quote='''");
            expect(hook.command.replace(/ --wait$/, "")).toBe(`"${process.execPath}" "${entry}" hook codex --endpoint ${endpoint}`);
        }
    });

    it("refuses to install from an npx cache given as a Windows path", () => {
        const npx = String.raw`C:\Users\u\AppData\Local\npm-cache\_npx\0123abcd\node_modules\n2n-nexus\build\index.js`;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            expect(runInstall({ action: "install", client: "claude", node: process.execPath, entry: npx })).toBe(1);
            expect(String(stderr.mock.calls[0]?.[0])).toContain("npx cache");
        } finally {
            stderr.mockRestore();
        }
        expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(false);
    });

    it("leaves Claude hook commands unchanged", () => {
        for (const hook of install("claude")) expect(hook.commandWindows).toBeUndefined();
    });

    it.runIf(process.platform === "win32")("executes the installed command in Windows PowerShell with literal arguments and stdin", () => {
        const hook = install("codex")[0];
        const script = path.join(dir, "hook.ps1");
        fs.writeFileSync(script, "\uFEFF" + hook.commandWindows!);
        const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "installation-test" });
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", input });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ args: ["hook", "codex", "--endpoint", endpoint], input });
    }, 30_000); // Windows PowerShell can take seconds to start on a CI runner
});

describe("Antigravity Windows hooks", () => {
    it("encodes every argument, quotes and cmd metacharacters included, so that it reads back unchanged", () => {
        for (const event of ["SessionStart", "PreInvocation", "Stop"]) {
            const command = antigravityHookCommand(process.execPath, entry, event, endpoint, "win32");
            expect(command).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
            expect(parseAntigravityHookCommand(command)).toEqual({ node: process.execPath, entry, event, endpoint });
        }
    });

    it.runIf(process.platform === "win32")("runs the installed command through cmd /c, as Antigravity does, with literal arguments and stdin", () => {
        expect(runInstall({ action: "install", client: "antigravity", node: process.execPath, entry, endpoint })).toBe(0);
        const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".gemini", "config", "hooks.json"), "utf8")) as Record<string, Record<string, Array<{ command: string }>>>;
        const command = hooks["n2n-nexus"].Stop[0].command;
        const input = JSON.stringify({ hookEventName: "Stop", conversationId: "installation-test" });
        const result = spawnSync(process.env.comspec || "cmd.exe", ["/d", "/c", command], { encoding: "utf8", input, windowsVerbatimArguments: true });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ args: ["hook", "antigravity", "Stop", "--endpoint", endpoint], input });
    }, 30_000);
});

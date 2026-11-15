/**
 * Run the `claude` / `codex` / `pi` command without a shell. On Windows npm installs
 * them as `.cmd` shims, which Node cannot start without cmd.exe, and cmd.exe
 * would parse the arguments again: a message text from another session could
 * end a quoted argument and run commands, and a newline ends the command line.
 * So a shim written by npm is resolved to the script it runs, started with
 * this Node; an `.exe` or `.com` runs directly; anything else is not run.
 *
 * Node built-ins only: the hook command imports this to run `codex queue`.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The bin path in npm's cmd-shim launch line: `"%dp0%\<path>" %*`. */
const NPM_SHIM_TARGET = /"%~?dp0%?\\([^"]+)"\s*%\*/;

/** The program and leading arguments that run `name` on this platform, or null when it cannot be run without a shell. */
export function clientCommand(name: string): { command: string; args: string[] } | null {
    if (process.platform !== "win32") return { command: name, args: [] };
    const file = findOnPath(name);
    if (!file) return null;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".exe" || ext === ".com") return { command: file, args: [] };
    if (ext !== ".cmd" && ext !== ".bat") return null;
    const target = NPM_SHIM_TARGET.exec(fs.readFileSync(file, "utf8"))?.[1];
    if (!target) return null;
    const script = path.join(path.dirname(file), ...target.split(/[\\/]+/));
    const scriptExt = path.extname(script).toLowerCase();
    if (scriptExt === ".exe") return { command: script, args: [] };
    return [".js", ".cjs", ".mjs"].includes(scriptExt) || scriptExt === "" ? { command: process.execPath, args: [script] } : null;
}

/** `name` as given (a path) or the first PATH entry with a PATHEXT extension that exists. */
function findOnPath(name: string): string | null {
    const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const candidates = (base: string) => path.extname(base) ? [base] : exts.map((ext) => base + ext.toLowerCase());
    const dirs = /[\\/]/.test(name) ? [""] : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const file of candidates(dir ? path.join(dir, name) : name)) {
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        }
    }
    return null;
}

/** spawnSync for a client command; a command that cannot be run reports ENOENT like a missing one. */
export function spawnClientSync(name: string, args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
    const resolved = clientCommand(name);
    if (!resolved) {
        const error = Object.assign(new Error(`spawnSync ${name} ENOENT`), { code: "ENOENT" });
        return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error };
    }
    return spawnSync(resolved.command, [...resolved.args, ...args], options);
}

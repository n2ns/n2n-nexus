/**
 * The client process a background wait would wake, so that the wait ends when
 * it is gone instead of keeping the session listening: Claude Code names its
 * own process in CLAUDE_PID; for Codex the Stop hook looks it up among its
 * ancestors and hands it to the detached wait (`--client-pid`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Shells a client may run a hook command through (Codex on Windows: PowerShell for commandWindows). */
export const SHELL_NAMES: readonly string[] = ["sh", "bash", "dash", "zsh", "fish", "powershell", "pwsh", "cmd"];

/** Whether process `pid` runs (EPERM: it runs, as another user). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** A positive integer process id, else undefined. */
export function parsePid(value: string | undefined): number | undefined {
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The name (lower case) and parent of process `pid` on Linux or macOS; throws when it cannot be read. */
function describe(pid: number): { name: string; ppid: number } {
    let name: string;
    let ppid: number;
    if (process.platform === "linux") {
        // "<pid> (<comm>) <state> <ppid> ...": comm may hold spaces and parentheses.
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        name = stat.slice(stat.indexOf("(") + 1, close);
        ppid = Number(stat.slice(close + 2).split(" ")[1]);
    } else {
        const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim();
        const m = /^(\d+)\s+(.*)$/.exec(out);
        if (!m) throw new Error(`no process ${pid}`);
        ppid = Number(m[1]);
        name = path.basename(m[2]);
    }
    if (!Number.isSafeInteger(ppid) || ppid <= 0 || !name) throw new Error(`no process ${pid}`);
    return { name: name.toLowerCase(), ppid };
}

/**
 * The process that ran this hook, past the shells it went through: the
 * nearest ancestor that is not a shell; undefined when it cannot be told.
 * Linux and macOS only: on Windows the PowerShell that starts the detached wait
 * looks it up itself (hook.ts startDetached), saving a PowerShell of its own.
 */
export function hookClientPid(): number | undefined {
    if (process.platform === "win32") return undefined;
    try {
        let pid = process.ppid;
        for (let hops = 0; hops < 4; hops++) {
            const { name, ppid } = describe(pid);
            if (!SHELL_NAMES.includes(name)) return pid;
            pid = ppid;
        }
    } catch {
        // Not readable: the wait runs without the check.
    }
    return undefined;
}

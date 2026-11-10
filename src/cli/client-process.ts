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
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "powershell", "pwsh", "cmd"]);

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

/** Every process on Windows, by id: one PowerShell query instead of one per ancestor. */
let windowsProcesses: Map<number, { name: string; ppid: number }> | undefined;

function listWindowsProcesses(): Map<number, { name: string; ppid: number }> {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const out = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const list = new Map<number, { name: string; ppid: number }>();
    for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (.+)$/.exec(line.trim());
        if (m) list.set(Number(m[1]), { ppid: Number(m[2]), name: m[3] });
    }
    return list;
}

/** The name (lower case, without .exe) and parent of process `pid`; throws when it cannot be read. */
function describe(pid: number): { name: string; ppid: number } {
    let name: string;
    let ppid: number;
    if (process.platform === "linux") {
        // "<pid> (<comm>) <state> <ppid> ...": comm may hold spaces and parentheses.
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        name = stat.slice(stat.indexOf("(") + 1, close);
        ppid = Number(stat.slice(close + 2).split(" ")[1]);
    } else if (process.platform === "win32") {
        const found = (windowsProcesses ??= listWindowsProcesses()).get(pid);
        if (!found) throw new Error(`no process ${pid}`);
        ({ name, ppid } = found);
    } else {
        const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim();
        const m = /^(\d+)\s+(.*)$/.exec(out);
        if (!m) throw new Error(`no process ${pid}`);
        ppid = Number(m[1]);
        name = path.basename(m[2]);
    }
    if (!Number.isSafeInteger(ppid) || ppid <= 0 || !name) throw new Error(`no process ${pid}`);
    return { name: name.toLowerCase().replace(/\.exe$/, ""), ppid };
}

/**
 * The process that ran this hook, past the shells it went through: the
 * nearest ancestor that is not a shell; undefined when it cannot be told.
 */
export function hookClientPid(): number | undefined {
    try {
        let pid = process.ppid;
        for (let hops = 0; hops < 4; hops++) {
            const { name, ppid } = describe(pid);
            if (!SHELLS.has(name)) return pid;
            pid = ppid;
        }
    } catch {
        // Not readable: the wait runs without the check.
    }
    return undefined;
}

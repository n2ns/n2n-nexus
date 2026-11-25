// Daily updates are registered per OS user, independently of the npm prefix.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryScript } from "./entry.js";

const windows = process.platform === "win32";
function scheduleDir(): string {
    return path.join(windows ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local") : path.join(os.homedir(), ".local/share"), "n2n-nexus/updates");
}

function appearsInstalled(): boolean {
    const entry = entryScript();
    return entry.endsWith(path.join("node_modules", "n2n-nexus", "build", "index.js")) && !/[/\\]_npx[/\\]/.test(entry);
}

type ScheduleChoice = "off" | "disabling" | "on" | { node: string; entry: string };

function readChoice(dir: string): ScheduleChoice | undefined {
    try {
        const value = fs.readFileSync(path.join(dir, "client-choice"), "utf8").trim();
        if (value === "off" || value === "disabling" || value === "on") return value;
        return JSON.parse(value);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function missingScheduleTarget(choice: ScheduleChoice | undefined): boolean {
    return typeof choice === "object" && (!fs.existsSync(choice.node) || !fs.existsSync(choice.entry));
}

function removalPending(dir: string): boolean {
    return fs.existsSync(path.join(dir, "client-removal-pending"));
}

/** Fast SessionStart path. Once configured, no npm command or scheduler process starts. */
export function clientScheduleNeedsSetup(): boolean {
    if (!appearsInstalled()) return false;
    const dir = scheduleDir();
    const choice = readChoice(dir);
    if (choice === "off") return removalPending(dir);
    if (!choice || choice === "disabling") return true;
    const runner = path.join(dir, windows ? "client.ps1" : "client.sh");
    return missingScheduleTarget(choice) || !fs.existsSync(runner);
}

function runSchedule(action: "status" | "on" | "off", argv: string[], env: NodeJS.ProcessEnv): number {
    const script = fs.readFileSync(new URL(`../../autoupdate/schedule.${windows ? "ps1" : "sh"}`, import.meta.url), "utf8");
    const exe = windows ? path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/sh";
    const params = windows
        ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
        : ["-c", script, "schedule", action, "client", ...argv];
    const result = spawnSync(exe, params, {
        stdio: "inherit",
        env: windows ? { ...env, N2N_NEXUS_UPDATE_SCHEDULE: JSON.stringify({ action, component: "client", argv }) } : env
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
}

export async function clientUpdateSchedule(action: "on" | "off" | "default"): Promise<number> {
    if (action === "default" && !appearsInstalled()) return 0;
    const dir = scheduleDir();
    const argv: string[] = [];
    const env = { ...process.env };
    if (action !== "off") {
        const { globalNpm, NotGlobalClientError } = await import("./auto-update.js");
        try {
            const { node, entry, prefix } = globalNpm();
            argv.push(node, entry, "auto-update", "run");
            // A --prefix passed to the installing npm may be absent from the scheduler's environment.
            delete env.npm_config_prefix;
            env.NPM_CONFIG_PREFIX = prefix;
        } catch (error) {
            if (action === "default" && error instanceof NotGlobalClientError) return 0;
            throw error;
        }
    }

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import("node:sqlite");
    const lock = new DatabaseSync(path.join(dir, "client-schedule-lock.db"));
    try {
        lock.exec("PRAGMA busy_timeout=15000; BEGIN IMMEDIATE");
        const record = (choice: ScheduleChoice) => {
            const value = typeof choice === "string" ? choice : JSON.stringify(choice);
            const tmp = path.join(dir, "client-choice.tmp");
            fs.writeFileSync(tmp, value + "\n", { mode: 0o600 });
            fs.renameSync(tmp, path.join(dir, "client-choice"));
        };
        const choice = readChoice(dir);
        if (action === "off" || (action === "default" && choice === "disabling")) {
            record("disabling");
            const result = runSchedule("off", [], env);
            if (result === 0) record("off");
            return result;
        }
        if (action === "default") {
            if (choice === "off") return removalPending(dir) ? runSchedule("off", [], env) : 0;
            const status = runSchedule("status", [], env);
            // Keep a working job, including one created by the earlier explicit on command.
            // Replace a job whose recorded global installation has since been removed.
            if (status === 0 && !missingScheduleTarget(choice)) {
                if (!choice) record("on");
                return 0;
            }
            if (status !== 0 && status !== 3) return status;
        }
        const result = runSchedule("on", argv, env);
        if (result === 0) record({ node: argv[0], entry: argv[1] });
        return result;
    } finally {
        lock.close();
    }
}

/** Scheduling may be unavailable during installation. Retry on the next client registration or session. */
export async function ensureClientUpdateSchedule(): Promise<void> {
    try {
        const code = await clientUpdateSchedule("default");
        if (code !== 0) throw new Error(`scheduler exited with ${code}`);
    } catch (error) {
        process.stderr.write(`[n2n-nexus] Daily client updates could not be registered: ${(error as Error).message}. Setup will be retried.\n`);
    }
}

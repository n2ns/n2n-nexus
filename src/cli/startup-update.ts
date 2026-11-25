import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { entryScript } from "./entry.js";

function choiceFile(): string {
    const base = process.platform === "win32"
        ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local")
        : path.join(os.homedir(), ".local/share");
    return path.join(base, "n2n-nexus/updates/client-choice");
}

export function clientUpdateStateDir(prefix: string): string {
    const id = createHash("sha256").update(fs.realpathSync(prefix)).digest("hex").slice(0, 24);
    return path.join(os.homedir(), ".local/state/n2n-nexus/client-update", id);
}

/** npm's standard global package layout under a prefix. Does not run npm or contact the registry. */
export function packagePrefix(entry: string): string | undefined {
    const suffix = path.join(process.platform === "win32" ? "" : "lib", "node_modules/n2n-nexus/build/index.js");
    if (!entry.endsWith(path.sep + suffix) || /[/\\]_npx[/\\]/.test(entry)) return undefined;
    return path.resolve(entry.slice(0, -suffix.length));
}

function looksInstalled(): boolean {
    const entry = entryScript();
    return entry.endsWith(path.join("node_modules", "n2n-nexus", "build", "index.js")) && !/[/\\]_npx[/\\]/.test(entry);
}

export async function lastClientUpdateFailure(): Promise<string | undefined> {
    if (!looksInstalled()) return undefined;
    const { clientUpdateLocation, NotGlobalClientError } = await import("./auto-update.js");
    let stateDir: string;
    try {
        ({ stateDir } = clientUpdateLocation());
    } catch (error) {
        if (error instanceof NotGlobalClientError) return undefined;
        throw error;
    }
    try {
        return fs.readFileSync(path.join(stateDir, "failure.txt"), "utf8").trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/** Fast SessionStart gate: never invoke npm on the foreground hook path. The
 * detached updater verifies the actual global prefix before touching anything. */
export function shouldCheckClient(): boolean {
    if (!looksInstalled()) return false;
    try {
        const choice = fs.readFileSync(choiceFile(), "utf8").trim();
        return choice !== "off" && choice !== "disabling";
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
    }
}

export async function setClientStartupUpdates(action: "on" | "off"): Promise<void> {
    if (action === "on") (await import("./auto-update.js")).globalNpm();
    const file = choiceFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID();
    try {
        fs.writeFileSync(tmp, action + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    process.stdout.write(`Client session-start updates: ${action}\n`);
}

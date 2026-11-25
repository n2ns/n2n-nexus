import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotGlobalClientError, updateGlobalClient } from "./auto-update.js";

type Command = { exe: string; args: string[] };

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
    }
}

export function localHostCommand(): Command | undefined {
    const windows = process.platform === "win32";
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
    const name = windows ? "n2n-nexus-host.exe" : "n2n-nexus-host";
    if (windows) {
        if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs/n2n-nexus-host"));
        dirs.push(path.join(process.env.SCOOP || path.join(os.homedir(), "scoop"), "apps/n2n-nexus-host/current"));
    } else if (process.platform === "darwin") {
        dirs.push("/opt/homebrew/bin", "/usr/local/bin");
    }
    for (const dir of dirs) {
        const file = path.join(dir, name);
        if (isFile(file)) return { exe: file, args: ["auto-update", "run"] };
    }
    return undefined;
}

export async function runUpdate(argv: string[]): Promise<number> {
    if (argv.length) {
        console.error("Usage: n2n-nexus update");
        return 2;
    }
    let failed = false;
    let found = false;
    // Finish the host first: updating our own npm package can replace the files of this CLI.
    try {
        const host = localHostCommand();
        if (host) {
            found = true;
            process.stdout.write("Checking local host…\n");
            const result = spawnSync(host.exe, host.args, { stdio: "inherit", windowsHide: true });
            if (result.error) throw result.error;
            if (result.status === 2) throw new Error("This host did not accept auto-update. Upgrade a legacy host once using its original installation method.");
            if (result.status !== 0) throw new Error(`host updater exited with ${result.signal ?? result.status}`);
        } else {
            process.stdout.write("Host: no local installation found on PATH or in the standard install location, skipped.\n");
        }
    } catch (error) {
        failed = true;
        console.error("Host update failed:", (error as Error).message);
    }
    try {
        process.stdout.write("Checking global npm client…\n");
        await updateGlobalClient();
        found = true;
    } catch (error) {
        if (error instanceof NotGlobalClientError) {
            process.stdout.write("Client: this command is outside the global npm installation, skipped.\n");
        } else {
            failed = true;
            console.error("Client update failed:", (error as Error).message);
        }
    }
    return found && !failed ? 0 : 1;
}

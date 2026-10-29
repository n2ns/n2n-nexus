/**
 * Where this conversation runs, which the hook command adds to the input of
 * every event it forwards as `machine`, so that other sessions can tell the machines apart
 * (sessions on different machines or WSL distributions often share a working directory).
 * Node built-ins only: the hook command imports this on client events.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

type Machine = { hostname: string; platform: string; environment: string; utcOffset: number };

/** darwin, linux, win32 as Node reports them; wsl for a Linux that runs under Windows. */
export function platformOf(platform: string = process.platform, readProcVersion: () => string = () => fs.readFileSync("/proc/version", "utf8")): string {
    if (platform !== "linux") return platform;
    try {
        return /microsoft/i.test(readProcVersion()) ? "wsl" : "linux";
    } catch {
        return "linux";
    }
}

/**
 * The machine's name. On macOS the name set in System Settings (ComputerName):
 * the host name there is a model name such as MacBook-Air that two Macs share,
 * and it changes with the network. Elsewhere, and when that cannot be read, the
 * host name without the `.local` suffix that macOS adds.
 */
export function hostnameOf(
    platform: string = process.platform,
    hostname: string = os.hostname(),
    readComputerName: () => string = () => execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
): string {
    if (platform === "darwin") {
        try {
            const name = readComputerName().trim();
            if (name) return name;
        } catch {
            // fall back to the host name
        }
    }
    return hostname.replace(/\.local$/i, "");
}

/** What tells environments that share the host name apart: the WSL distribution, else "". */
export function environmentOf(platform: string, env: NodeJS.ProcessEnv = process.env): string {
    return platform === "wsl" ? env.WSL_DISTRO_NAME ?? "" : "";
}

export function machineInfo(now: Date = new Date()): Machine {
    const platform = platformOf();
    // 0 - x, not -x: at UTC -x is -0, which JSON writes as 0.
    return { hostname: hostnameOf(), platform, environment: environmentOf(platform), utcOffset: 0 - now.getTimezoneOffset() };
}

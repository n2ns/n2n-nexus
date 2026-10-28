/**
 * Where this conversation runs, which the hook command adds to the input of
 * every event it forwards as `machine`, so that other sessions can tell the machines apart
 * (several sessions share a name and a working directory across machines).
 * Node built-ins only: the hook command imports this on client events.
 */
import fs from "node:fs";
import os from "node:os";

export type Machine = { hostname: string; platform: string; utcOffset: number };

/** darwin, linux, win32 as Node reports them; wsl for a Linux that runs under Windows. */
export function platformOf(platform: string = process.platform, readProcVersion: () => string = () => fs.readFileSync("/proc/version", "utf8")): string {
    if (platform !== "linux") return platform;
    try {
        return /microsoft/i.test(readProcVersion()) ? "wsl" : "linux";
    } catch {
        return "linux";
    }
}

/** The host name without the `.local` suffix that macOS adds. */
export function hostnameOf(hostname: string = os.hostname()): string {
    return hostname.replace(/\.local$/i, "");
}

export function machineInfo(now: Date = new Date()): Machine {
    // 0 - x, not -x: at UTC -x is -0, which JSON writes as 0.
    return { hostname: hostnameOf(), platform: platformOf(), utcOffset: 0 - now.getTimezoneOffset() };
}

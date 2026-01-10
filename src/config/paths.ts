/**
 * Path Resolution Logic
 */
import path from "path";
import os from "os";
import { SERVICE_NAME } from "../constants.js";
import { getArg } from "./cli.js";

/**
 * Normalize and resolve the root storage path
 */
export function normalizeRootPath(inputPath: string | undefined): string {
    // Priority: CLI --root > ENV NEXUS_ROOT > System Default
    let root = inputPath || process.env.NEXUS_ROOT || getDefaultDataDir();

    // Resolve ~ to home directory
    if (root.startsWith("~")) {
        root = path.join(os.homedir(), root.slice(1));
    }

    // Cross-platform adaptation (WSL <-> Windows)
    if (process.platform === "linux" && /^[a-zA-Z]:[/\\]/.test(root)) {
        const drive = root[0].toLowerCase();
        root = `/mnt/${drive}${root.slice(2).replace(/\\/g, "/")}`;
    }

    return path.resolve(root);
}

/**
 * Get the default data directory
 */
export function getDefaultDataDir(): string {
    const home = os.homedir();
    // Use ~/.n2n-nexus for all platforms (developer-friendly convention)
    return path.join(home, `.${SERVICE_NAME}`);
}

/**
 * Get the root storage path from CLI or environment
 */
export function getRootPath(): string {
    return normalizeRootPath(getArg("--root"));
}

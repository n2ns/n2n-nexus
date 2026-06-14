import { createDaemonServer } from "./server.js";
import { pkg, getRootPath } from "../config/index.js";
import { NEXUS_HOST } from "../constants.js";

function parsePort(): number {
    const argIndex = process.argv.indexOf("--port");
    if (argIndex !== -1) {
        const parsed = parseInt(process.argv[argIndex + 1] || "", 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    const envPort = parseInt(process.env.NEXUS_DAEMON_PORT || process.env.NEXUS_PORT || "", 10);
    if (!isNaN(envPort) && envPort > 0) return envPort;
    return 5688;
}

function parseHost(): string {
    const argIndex = process.argv.indexOf("--host");
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        return process.argv[argIndex + 1];
    }
    return process.env.NEXUS_HOST || NEXUS_HOST;
}

export async function runDaemon(): Promise<void> {
    const port = parsePort();
    const host = parseHost();
    const root = getRootPath();

    // Inject root path into CONFIG via env so StorageManager picks it up
    process.env.NEXUS_ROOT = root;

    const { server, storageInfo } = await createDaemonServer({ port, host, version: pkg.version });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            console.error(`[n2n-nexus] Daemon v${pkg.version} listening on http://${host}:${port}`);
            console.error(`[n2n-nexus] Storage: ${root} (${storageInfo.storageMode}${storageInfo.isDegraded ? ", degraded" : ""})`);
            resolve();
        });
    });

    process.once("SIGINT", () => { console.error("[n2n-nexus] Shutting down."); server.close(() => process.exit(0)); });
    process.once("SIGTERM", () => { server.close(() => process.exit(0)); });

    console.error("[n2n-nexus] Ready. Press Ctrl+C to stop.");
}

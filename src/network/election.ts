/**
 * Host Election Logic
 * 
 * Handles port scanning, handshake probing, and Host/Guest election.
 */
import http from "http";
import { NEXUS_HOST, PORT_RANGE_START, PORT_RANGE_END, HANDSHAKE_TIMEOUT, SERVICE_NAME } from "../constants.js";
import { getArg } from "../config/cli.js";

// We need pkg version for handshake - import dynamically to avoid circular dep
let pkgVersion = "0.0.0";
import("../config/index.js").then(m => { pkgVersion = m.pkg.version; }).catch(() => { });

/**
 * Probe a port to see if it's a Nexus Host using the Custom Handshake Protocol
 */
export async function probeHost(port: number, myId: string): Promise<{ isNexus: boolean; rootStorage?: string }> {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            clientVersion: pkgVersion,
            instanceId: myId
        });

        const req = http.request({
            hostname: NEXUS_HOST,
            port: port,
            path: "/nexus/handshake",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: HANDSHAKE_TIMEOUT
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    if (info.service === SERVICE_NAME && info.role === "host") {
                        resolve({ isNexus: true, rootStorage: info.rootStorage });
                    } else {
                        resolve({ isNexus: false });
                    }
                } catch {
                    resolve({ isNexus: false });
                }
            });
        });

        req.on("error", () => resolve({ isNexus: false }));
        req.on("timeout", () => {
            req.destroy();
            resolve({ isNexus: false });
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Automatic Host Election
 * 
 * For each port in range:
 * 1. Try to bind → Success → I am Host
 * 2. Bind fails → Try handshake → Success → I am Guest
 * 3. Handshake fails → Port occupied by non-Nexus → Next port
 * 
 * Optimized for speed: Fast-fail on bind, short timeout on handshake.
 */
/**
 * Automatic Host Election
 * 
 * Strategy:
 * 1. Parallel Scan (0-200ms): Race to bind or handshake on the first batch of ports.
 * 2. Sequential Scan: If all preferred ports are busy/zombie, try remaining ports.
 * 3. Fallback: Bind to port 0 (OS assigned) to guarantee isolation.
 */
export async function isHostAutoElection(
    _root: string,
    blacklistPorts: number[] = []
): Promise<{ isHost: boolean; port: number; server?: http.Server; rootStorage?: string }> {
    const manualPort = parseInt(getArg("--port") || "0");
    const myId = getArg("--id") || `node-${Math.random().toString(36).substring(2, 6)}`;

    // 0. Manual Port Priority
    if (manualPort > 0) {
        const result = await checkPort(manualPort, myId);
        if (result) return result;
    }

    const startPort = PORT_RANGE_START;
    const endPort = PORT_RANGE_END;

    // 1. Parallel Scan of first 5 ports (High Probability Zone)
    const BATCH_SIZE = 5;
    const batchEnd = Math.min(startPort + BATCH_SIZE, endPort);
    const checks: Promise<{ isHost: boolean; port: number; server?: http.Server; rootStorage?: string } | null>[] = [];

    for (let port = startPort; port < batchEnd; port++) {
        if (blacklistPorts.includes(port)) continue;
        checks.push(checkPort(port, myId));
    }

    try {
        // Wait for all checks to complete, then pick the first valid result (Win-Win)
        const results = await Promise.all(checks);

        // Priority: Prefer Host (Bind Success) over Guest (Existing Nexus) if both happen?
        // Actually, 'checkPort' tries Bind FIRST, then Handshake.
        // So if we get a result from checkPort, it's a definitive state for that port.
        // We pick the first non-null result based on port order (implicitly by array index if we iterated, but here we scan).
        const winner = results.find(r => r !== null);

        if (winner) {
            return winner;
        }
    } catch {
        // Continue to sequential
    }

    // 2. Sequential Scan for the rest (Low Probability)
    for (let port = batchEnd; port <= endPort; port++) {
        if (blacklistPorts.includes(port)) continue;
        const result = await checkPort(port, myId);
        if (result) return result;
    }

    // 3. Fallback: Isolated Host
    // 3. Fallback: Isolated Host
    console.error(`[Nexus] Preferred ports ${startPort}-${endPort} busy. Starting isolated Host...`);
    const fallbackServer = http.createServer();
    const fallbackPort = await new Promise<number>((resolve, reject) => {
        fallbackServer.listen(0, NEXUS_HOST, () => {
            const addr = fallbackServer.address();
            if (addr && typeof addr !== 'string') resolve(addr.port);
            else reject("Failed to bind fallback port");
        });
    });

    return { isHost: true, port: fallbackPort, server: fallbackServer };
}

/**
 * Atomic Port Check: 
 * Returns result if we successfully Bind (Host) or Handshake (Guest).
 * Returns null if port is busy with non-Nexus service.
 */
async function checkPort(port: number, myId: string): Promise<{ isHost: boolean; port: number; server?: http.Server; rootStorage?: string } | null> {
    // A. Try Bind
    const bindResult = await new Promise<{ success: boolean; server?: http.Server }>((resolve) => {
        const server = http.createServer();
        server.on("error", () => resolve({ success: false }));
        server.listen(port, NEXUS_HOST, () => resolve({ success: true, server }));
    });

    if (bindResult.success) {
        return { isHost: true, port, server: bindResult.server };
    }

    // B. Try Handshake (if bind failed)
    try {
        const probe = await probeHost(port, myId);
        if (probe.isNexus) {
            return { isHost: false, port, rootStorage: probe.rootStorage };
        }
    } catch {
        // Handshake failed/timeout
    }

    return null;
}

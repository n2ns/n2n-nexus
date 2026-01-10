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
 */
export async function isHostAutoElection(
    _root: string,
    blacklistPorts: number[] = []
): Promise<{ isHost: boolean; port: number; server?: http.Server; rootStorage?: string }> {
    const startPort = PORT_RANGE_START;
    const endPort = PORT_RANGE_END;
    const myId = getArg("--id") || `node-${Math.random().toString(36).substring(2, 6)}`;

    for (let port = startPort; port <= endPort; port++) {
        if (blacklistPorts.includes(port)) continue;

        // 1. Try to bind port
        const bindResult = await new Promise<{ success: boolean; server?: http.Server }>((resolve) => {
            const server = http.createServer();
            server.on("error", () => resolve({ success: false }));
            server.listen(port, NEXUS_HOST, () => resolve({ success: true, server }));
        });

        if (bindResult.success) {
            // Bind success → I am Host
            return { isHost: true, port, server: bindResult.server };
        }

        // 2. Bind failed → Try handshake
        const probe = await probeHost(port, myId);
        if (probe.isNexus) {
            // Handshake success → I am Guest
            return { isHost: false, port, rootStorage: probe.rootStorage };
        }

        // 3. Handshake failed → Port occupied by non-Nexus → Continue
    }

    // All ports unavailable
    console.error(`[Nexus] All ports ${startPort}-${endPort} occupied by non-Nexus processes.`);
    throw new Error("No available port for Nexus");
}

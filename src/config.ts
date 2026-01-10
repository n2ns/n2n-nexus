import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { HubConfig } from "./types.js";
import fs from "fs";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// Load version from package.json
const pkgPath = path.resolve(__dirname, "../package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

const getArg = (k: string) => {
    const i = args.indexOf(k);
    return i !== -1 && args[i + 1] ? args[i + 1] : "";
};

const hasFlag = (k: string) => args.includes(k) || args.includes(k.charAt(1) === "-" ? k : k.substring(0, 2));

// --- CLI Commands Handlers ---
if (hasFlag("--help") || hasFlag("-h")) {
    console.error(`
n2ns Nexus 🚀 - Local Digital Asset Hub (MCP Server) v${pkg.version}

USAGE:
  npx -y @datafrog-io/n2n-nexus [options]

DESCRIPTION:
  A local-first project management and collaboration hub designed for 
  multi-AI assistant coordination across different IDEs (Cursor, VS Code, etc.).

OPTIONS:
  --root <path>     Directory for data persistence. Default: ./storage
  --version, -v     Show version number.
  --help, -h        Show this message.

MCP CONFIG EXAMPLE (claude_desktop_config.json):
  {
    "mcpServers": {
      "n2n-nexus": {
        "command": "npx",
        "args": ["-y", "@datafrog-io/n2n-nexus", "--root", "/path/to/storage"]
      }
    }
  }

ENVIRONMENT VARIABLES:
  NEXUS_ROOT        Override default storage path.
    `);
    process.exit(0);
}

if (hasFlag("--version") || hasFlag("-v")) {
    console.error(pkg.version);
    process.exit(0);
}

// --- Path Normalization Logic ---
function normalizeRootPath(inputPath: string | undefined): string {
    // 1. Priority: CLI --root > ENV NEXUS_ROOT > System Default (XDG/AppData)
    let root = inputPath || process.env.NEXUS_ROOT || getDefaultDataDir();

    // 2. Resolve ~ to home directory
    if (root.startsWith("~")) {
        root = path.join(os.homedir(), root.slice(1));
    }

    // 3. Cross-platform adaptation (WSL <-> Windows)
    // If running on Linux (WSL) but path looks like Windows (D:/ or C:\\)
    if (process.platform === "linux" && /^[a-zA-Z]:[/\\]/.test(root)) {
        const drive = root[0].toLowerCase();
        root = `/mnt/${drive}${root.slice(2).replace(/\\/g, "/")}`;
    }

    return path.resolve(root);
}

function getDefaultDataDir(): string {
    const home = os.homedir();
    const appName = "n2n-nexus";

    switch (process.platform) {
        case "win32":
            return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), appName);
        case "darwin":
            return path.join(home, "Library", "Application Support", appName);
        default: // linux, wsl, etc.
            return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), appName);
    }
}


/**
 * Probe a port to see if it's a Nexus Host
 */
/**
 * Probe a port to see if it's a Nexus Host using the Custom Handshake Protocol
 */
async function probeHost(port: number, myId: string): Promise<{ isNexus: boolean; rootStorage?: string }> {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            clientVersion: pkg.version,
            instanceId: myId
        });

        const req = http.request({
            hostname: "127.0.0.1",
            port: port,
            path: "/nexus/handshake",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 500
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    if (info.service === "n2n-nexus" && info.role === "host") {
                        // console.error(`[Nexus Handshake] Connected to Host v${info.serverVersion} (Protocol ${info.protocol})`);
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
 * Automatic Host Election (Port-Based 5688-5700)
 * Strategy: Probe-First + Atomic Bind + Join Winner on Failure
 * 
 * 1. First, scan all ports to find existing Host
 * 2. If found, join it immediately
 * 3. If not found, try to become Host
 * 4. If bind fails, wait and re-probe (give winner time to start)
 */
async function isHostAutoElection(root: string): Promise<{ isHost: boolean; port: number; server?: http.Server; rootStorage?: string }> {
    const startPort = 5688;
    const endPort = 5800;
    let retryCount = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        // Phase 1: Probe-First - Check if any Host already exists (Concurrent Batch Scan)
        const BATCH_SIZE = 20;
        const myId = getArg("--id") || `candidate-${Math.random().toString(36).substring(2, 6)}`;

        for (let batchStart = startPort; batchStart <= endPort; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endPort);
            const promises = [];
            for (let port = batchStart; port <= batchEnd; port++) {
                promises.push(probeHost(port, myId).then(res => ({ port, ...res })));
            }

            const results = await Promise.all(promises);
            const found = results.find(r => r.isNexus);
            if (found) {
                return { isHost: false, port: found.port, rootStorage: found.rootStorage };
            }
        }

        // Phase 2: No Host found, attempt to become Host
        for (let port = startPort; port <= endPort; port++) {
            const result = await new Promise<{ isHost: boolean; server?: http.Server }>((resolve) => {
                const server = http.createServer((req, res) => {
                    // HANDSHAKE ENDPOINT
                    if (req.method === "POST" && req.url === "/nexus/handshake") {
                        let body = "";
                        req.on("data", chunk => body += chunk);
                        req.on("end", () => {
                            try {
                                const _clientInfo = JSON.parse(body);
                                // console.error(`[Nexus Handshake] Client connected: ${_clientInfo.instanceId} (v${_clientInfo.clientVersion})`);
                            } catch { /* ignore malformed */ }

                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({
                                service: "n2n-nexus",
                                protocol: "v1", // Nexus Handshake Protocol v1
                                role: "host",
                                serverVersion: pkg.version,
                                rootStorage: root,
                                status: "ready"
                            }));
                        });
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                });

                server.on("error", (_err: unknown) => {
                    resolve({ isHost: false });
                });

                server.listen(port, "0.0.0.0", () => {
                    resolve({ isHost: true, server });
                });
            });


            if (result.isHost) {
                return { isHost: true, port, server: result.server };
            }

            // Phase 3: Bind failed - another Guest won. Wait then join winner.
            await new Promise(r => setTimeout(r, 2000)); // Short wait for winner to stabilize
            const probe = await probeHost(port, myId);
            if (probe.isNexus) {
                return { isHost: false, port, rootStorage: probe.rootStorage };
            }
            // If still not Nexus, try next port
        }

        // Fallback: All ports occupied - progressive backoff retry
        const waitTime = retryCount < 5 ? 5000 : 30000;
        console.error(`[Nexus] All ports ${startPort}-${endPort} occupied. Retry #${retryCount + 1} in ${waitTime / 1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        retryCount++;
    }
}

/**
 * Automatic Project Name Detection
 */
function getAutoProjectName(): string {
    try {
        const pkgPath = path.join(process.cwd(), "package.json");
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
            if (pkg.name) return pkg.name.split("/").pop() || pkg.name;
        }
    } catch { /* ignore */ }
    const base = path.basename(process.cwd()) || "Assistant";
    // Append random suffix to prevent collisions when multiple IDEs open empty/same folders
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${base}-${suffix}`;
}

const rootPath = normalizeRootPath(getArg("--root"));
const election = await isHostAutoElection(rootPath);
const projectName = getAutoProjectName();

export const hostServer = election.server;

export const CONFIG: HubConfig = {
    // Priority: CLI --id > Auto-named (Project Name only)
    instanceId: getArg("--id") || projectName,
    isHost: election.isHost,
    // Inherit storage path if Guest, otherwise use local resolved path
    rootStorage: election.isHost ? rootPath : (election.rootStorage || rootPath),
    port: election.port
};

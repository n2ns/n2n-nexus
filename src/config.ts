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
    console.log(`
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
    console.log(pkg.version);
    process.exit(0);
}

// --- Path Normalization Logic ---
function normalizeRootPath(inputPath: string | undefined): string {
    // 1. Priority: CLI --root > ENV NEXUS_ROOT > Default ./storage
    let root = inputPath || process.env.NEXUS_ROOT || path.join(__dirname, "../storage");

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


/**
 * Probe a port to see if it's a Nexus Host
 */
async function probeHost(port: number): Promise<{ isNexus: boolean; rootStorage?: string }> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/hello`, { timeout: 500 }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    if (info.service === "n2n-nexus" && info.role === "host") {
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
    const endPort = 5700;

    // Phase 1: Probe-First - Check if any Host already exists
    for (let port = startPort; port <= endPort; port++) {
        const probe = await probeHost(port);
        if (probe.isNexus) {
            return { isHost: false, port, rootStorage: probe.rootStorage };
        }
    }

    // Phase 2: No Host found, attempt to become Host
    for (let port = startPort; port <= endPort; port++) {
        const result = await new Promise<{ isHost: boolean; server?: http.Server }>((resolve) => {
            const server = http.createServer((req, res) => {
                if (req.url === "/hello") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        service: "n2n-nexus",
                        role: "host",
                        version: pkg.version,
                        rootStorage: root
                    }));
                    return;
                }
                res.writeHead(404);
                res.end();
            });

            server.on("error", (err: any) => {
                if (err.code === "EADDRINUSE") {
                    resolve({ isHost: false });
                } else {
                    resolve({ isHost: false });
                }
            });

            server.listen(port, "127.0.0.1", () => {
                resolve({ isHost: true, server });
            });
        });

        if (result.isHost) {
            return { isHost: true, port, server: result.server };
        }

        // Phase 3: Bind failed - another Guest won. Wait then join winner.
        await new Promise(r => setTimeout(r, 10000)); // Give winner 10s to start /hello
        const probe = await probeHost(port);
        if (probe.isNexus) {
            return { isHost: false, port, rootStorage: probe.rootStorage };
        }
        // If still not Nexus, try next port (occupied by non-Nexus service)
    }

    // Fallback: become Host on startPort (should rarely happen)
    return { isHost: true, port: startPort };
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
    return path.basename(process.cwd()) || "Assistant";
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

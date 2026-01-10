/**
 * Config Module - Central Configuration
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { HubConfig } from "../types.js";
import { SERVICE_NAME, FILE_ENCODING, PACKAGE_JSON } from "../constants.js";
import { getArg, hasFlag } from "./cli.js";
import { getRootPath } from "./paths.js";
import { isHostAutoElection } from "../network/election.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load version from package.json
const pkgPath = path.resolve(__dirname, `../../${PACKAGE_JSON}`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, FILE_ENCODING));

export { pkg };

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
  --root <path>     Directory for data persistence. Default: ~/.n2n-nexus
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

/**
 * Automatic Project Name Detection
 */
function getAutoProjectName(): string {
    try {
        const localPkgPath = path.join(process.cwd(), PACKAGE_JSON);
        if (fs.existsSync(localPkgPath)) {
            const localPkg = JSON.parse(fs.readFileSync(localPkgPath, FILE_ENCODING));
            if (localPkg.name) return localPkg.name.split("/").pop() || localPkg.name;
        }
    } catch { /* ignore */ }
    const base = path.basename(process.cwd()) || "Assistant";
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${base}-${suffix}`;
}

// Run election at module load
const rootPath = getRootPath();
const election = await isHostAutoElection(rootPath);
const projectName = getAutoProjectName();

export const hostServer = election.server;

export const CONFIG: HubConfig = {
    instanceId: getArg("--id") || projectName,
    isHost: election.isHost,
    rootStorage: election.isHost ? rootPath : (election.rootStorage || rootPath),
    port: election.port
};

// Re-export for Guest reconnection
export { isHostAutoElection } from "../network/election.js";

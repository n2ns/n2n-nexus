#!/usr/bin/env node
import { pkg } from "./config/index.js";

const command = process.argv[2] || "mcp";

if (command === "--version" || command === "-v") {
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
}

if (command === "--help" || command === "-h") {
    process.stdout.write(`
n2n-nexus v${pkg.version} — Multi-AI assistant coordination hub

USAGE:
  n2n-nexus daemon   Start the Nexus server (run once, stays alive)
  n2n-nexus mcp      Start the MCP proxy (launched by IDE automatically)

OPTIONS:
  --root <path>      Storage directory for daemon (default: ~/.n2n-nexus)
  --port <port>      HTTP port for daemon (default: 5688)
  --host <host>      Host address for daemon (default: 127.0.0.1)
  --id <id>          Instance ID for MCP proxy
  --version, -v      Show version
  --help, -h         Show this help

ENVIRONMENT:
  NEXUS_ROOT         Override --root
  NEXUS_DAEMON_PORT  Override --port
  NEXUS_HOST         Override --host
  NEXUS_ENDPOINT     Daemon URL for MCP proxy (default: http://127.0.0.1:5688)
  NEXUS_INSTANCE_ID  Override --id for MCP proxy
`);
    process.exit(0);
}

async function main() {
    if (command === "daemon") {
        const { runDaemon } = await import("./daemon/index.js");
        await runDaemon();
        return;
    }

    // Default: mcp
    const { NexusServer } = await import("./server/nexus.js");
    const server = new NexusServer();
    await server.run();
}

main().catch(err => {
    console.error("[n2n-nexus] Fatal error:", err);
    process.exit(1);
});

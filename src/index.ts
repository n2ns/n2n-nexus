#!/usr/bin/env node
/**
 * n2ns Nexus: Unified Project Asset & Collaboration Hub
 * Entry point for the Nexus MCP Server.
 */
import { NexusServer } from "./server/nexus.js";

async function main() {
    const server = new NexusServer();
    server.run().catch((error) => {
        console.error("[Nexus FATAL] Server failed to start:", error);
        process.exit(1);
    });
}

main();

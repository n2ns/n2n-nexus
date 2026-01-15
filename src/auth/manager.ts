import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "../config/index.js";

/**
 * Request Source Type
 */
export enum RequestOrigin {
    LOCAL_STDIO = "LOCAL_STDIO",
    REMOTE_GUEST = "REMOTE_GUEST",
    INTERNAL = "INTERNAL" // For buffered requests or internal logic
}

/**
 * Identifies the origin of an MCP request based on the transport.
 */
export function getRequestOrigin(extra: any): RequestOrigin {
    if (!extra || !extra.transport) {
        return RequestOrigin.INTERNAL;
    }

    const transport = extra.transport;
    const transportName = transport.constructor?.name;

    // Structural check: Stdio transport usually has these properties
    const isStdio = transportName === "StdioServerTransport" ||
        (transport as any)._isStdio === true;

    return isStdio ? RequestOrigin.LOCAL_STDIO : RequestOrigin.REMOTE_GUEST;
}

/**
 * List of tools that MUST ONLY be executed from the Host's Stdio transport.
 */
const HOST_ONLY_TOOLS = [
    "host_maintenance",
    "host_delete_project",
    "rename_project",
    "clear_global_logs",
    "archive_meeting",
    "update_global_strategy"
];

/**
 * Validates if the current request has permission to execute the target tool.
 * @throws Error if permission is denied.
 */
export function authorizeToolCall(toolName: string, origin: RequestOrigin): void {
    // 1. Process Level Check: If this process isn't even the host, it can't run these.
    // (Though usually Guest processes forward these, the Host must still verify).
    if (!CONFIG.isHost && HOST_ONLY_TOOLS.includes(toolName)) {
        throw new Error(`Instance Role Error: This instance is not a HOST and cannot run '${toolName}'.`);
    }

    // 2. Transport Level Check: Host process only allows these from its OWN Stdio.
    if (HOST_ONLY_TOOLS.includes(toolName)) {
        if (origin !== RequestOrigin.LOCAL_STDIO && origin !== RequestOrigin.INTERNAL) {
            throw new Error(`Permission Denied: Tool '${toolName}' requires direct Host Stdio privileges. Remote Guest access is forbidden.`);
        }
    }
}

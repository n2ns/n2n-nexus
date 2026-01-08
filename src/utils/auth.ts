import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../config.js";

/**
 * Validates host permissions for privileged tools.
 * @throws McpError if current session is not in Host mode.
 */
export function checkHostPermission(toolName: string): void {
    if (!CONFIG.isHost) {
        throw new McpError(ErrorCode.InvalidRequest, `Forbidden: ${toolName} requires Host rights.`);
    }
}

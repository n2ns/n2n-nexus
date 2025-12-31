import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../config.js";

/**
 * Validates moderator permissions for admin tools.
 * @throws McpError if current session is not in Moderator mode.
 */
export function checkModeratorPermission(toolName: string): void {
    if (!CONFIG.isModerator) {
        throw new McpError(ErrorCode.InvalidRequest, `Forbidden: ${toolName} requires Moderator rights.`);
    }
}

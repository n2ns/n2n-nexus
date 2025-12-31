import { TOOL_REGISTRY } from "./schemas.js";

/**
 * Dynamically generated Tool Definitions from Zod Schemas.
 * This ensures Tool Registry and Input Validation are always in sync.
 * Using native Zod 4 toJSONSchema support.
 */
export const TOOL_DEFINITIONS = Object.entries(TOOL_REGISTRY).map(([name, entry]) => ({
    name,
    description: entry.description,
    inputSchema: entry.schema.toJSONSchema()
}));

export { handleToolCall, ToolContext } from "./handlers.js";
export { TOOL_REGISTRY } from "./schemas.js";

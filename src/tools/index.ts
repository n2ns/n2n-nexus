/**
 * Token-Optimized Tool Exports
 * 
 * Uses hand-crafted minimal definitions instead of Zod toJSONSchema()
 * to reduce context window consumption by ~60%.
 */
import { TOOL_DEFINITIONS, ALL_TOOL_DEFINITIONS, ToolDefinition } from "./definitions.js";

export { TOOL_DEFINITIONS, ALL_TOOL_DEFINITIONS, ToolDefinition };
export { handleToolCall, ToolContext } from "./handlers.js";
export { TOOL_REGISTRY } from "./schemas.js";

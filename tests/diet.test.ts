import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleToolCall, ToolContext } from "../src/tools/handlers.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StorageManager } from "../src/storage/index.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import path from "path";
import { CONFIG } from "../src/config.js";
import { promises as fs } from "fs";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-diet");
CONFIG.rootStorage = TEST_ROOT;

describe("Tool Registry Diet Verification", () => {
    let mockContext: ToolContext;

    beforeEach(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {}
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await StorageManager.init();

        mockContext = {
            currentProject: null,
            setCurrentProject: vi.fn(),
            notifyResourceUpdate: vi.fn(),
        };
    });

    afterEach(async () => {
        closeDatabase();
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    const deprecatedTools = [
        "list_projects",
        "read_project",
        "list_global_docs",
        "read_global_doc",
        "list_meetings",
        "read_meeting"
    ];

    deprecatedTools.forEach(toolName => {
        it(`should throw MethodNotFound for removed tool: ${toolName}`, async () => {
            try {
                // We use an empty object for args since validation happens AFTER dispatch in handleToolCall
                // But handleToolCall dispatch throws first for unknown methods
                await handleToolCall(toolName, {}, mockContext);
                throw new Error(`Tool ${toolName} should not exist`);
            } catch (e: any) {
                // handleToolCall throws Standard MCP Error for unknown tool in switch default
                expect(e.code).toBe(ErrorCode.MethodNotFound);
            }
        });
    });
});

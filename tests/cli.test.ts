/**
 * CLI Module Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock process.argv before importing the module
describe("CLI Module", () => {
    const originalArgv = process.argv;

    afterEach(() => {
        process.argv = originalArgv;
        vi.resetModules();
    });

    describe("getArg", () => {
        it("should return argument value when present", async () => {
            process.argv = ["node", "script.js", "--root", "/custom/path"];
            const { getArg } = await import("../src/config/cli.js");
            expect(getArg("--root")).toBe("/custom/path");
        });

        it("should return empty string when argument not present", async () => {
            process.argv = ["node", "script.js"];
            const { getArg } = await import("../src/config/cli.js");
            expect(getArg("--root")).toBe("");
        });

        it("should return empty string when argument has no value", async () => {
            process.argv = ["node", "script.js", "--root"];
            const { getArg } = await import("../src/config/cli.js");
            expect(getArg("--root")).toBe("");
        });

        it("should handle multiple arguments", async () => {
            process.argv = ["node", "script.js", "--root", "/path", "--id", "test-id"];
            const { getArg } = await import("../src/config/cli.js");
            expect(getArg("--root")).toBe("/path");
            expect(getArg("--id")).toBe("test-id");
        });
    });

    describe("hasFlag", () => {
        it("should return true when flag is present", async () => {
            process.argv = ["node", "script.js", "--help"];
            const { hasFlag } = await import("../src/config/cli.js");
            expect(hasFlag("--help")).toBe(true);
        });

        it("should return false when flag is not present", async () => {
            process.argv = ["node", "script.js"];
            const { hasFlag } = await import("../src/config/cli.js");
            expect(hasFlag("--help")).toBe(false);
        });

        it("should handle short flags", async () => {
            process.argv = ["node", "script.js", "-h"];
            const { hasFlag } = await import("../src/config/cli.js");
            expect(hasFlag("-h")).toBe(true);
        });
    });
});

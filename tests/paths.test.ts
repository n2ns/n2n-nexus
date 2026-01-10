/**
 * Paths Module Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";

describe("Paths Module", () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    describe("getDefaultDataDir", () => {
        it("should return ~/.n2n-nexus for all platforms", async () => {
            const { getDefaultDataDir } = await import("../src/config/paths.js");
            const expected = path.join(os.homedir(), ".n2n-nexus");
            expect(getDefaultDataDir()).toBe(expected);
        });
    });

    describe("normalizeRootPath", () => {
        it("should expand ~ to home directory", async () => {
            const { normalizeRootPath } = await import("../src/config/paths.js");
            const result = normalizeRootPath("~/my-nexus");
            expect(result).toBe(path.join(os.homedir(), "my-nexus"));
        });

        it("should resolve relative paths to absolute", async () => {
            const { normalizeRootPath } = await import("../src/config/paths.js");
            const result = normalizeRootPath("./data");
            expect(path.isAbsolute(result)).toBe(true);
        });

        it("should use NEXUS_ROOT env when no input provided", async () => {
            process.env.NEXUS_ROOT = "/env/nexus/root";
            vi.resetModules();
            const { normalizeRootPath } = await import("../src/config/paths.js");
            const result = normalizeRootPath(undefined);
            expect(result).toBe("/env/nexus/root");
        });

        it("should prioritize input over NEXUS_ROOT env", async () => {
            process.env.NEXUS_ROOT = "/env/nexus/root";
            vi.resetModules();
            const { normalizeRootPath } = await import("../src/config/paths.js");
            const result = normalizeRootPath("/custom/path");
            expect(result).toBe("/custom/path");
        });

        it("should convert Windows path to WSL path on Linux", async () => {
            Object.defineProperty(process, "platform", { value: "linux" });
            vi.resetModules();
            const { normalizeRootPath } = await import("../src/config/paths.js");
            const result = normalizeRootPath("C:\\Users\\James\\.n2n-nexus");
            expect(result).toBe("/mnt/c/Users/James/.n2n-nexus");
        });
    });
});

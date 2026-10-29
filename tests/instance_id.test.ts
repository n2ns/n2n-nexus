import { describe, expect, it } from "vitest";
import os from "node:os";
import { resolveInstanceId } from "../src/server/instance-id.js";

describe("resolveInstanceId", () => {
    it("prefers the environment variable, then --id", () => {
        expect(resolveInstanceId({ NEXUS_INSTANCE_ID: "env-id" }, ["node", "x", "--id", "arg-id"], "/w")).toBe("env-id");
        expect(resolveInstanceId({}, ["node", "x", "--id", "arg-id"], "/w")).toBe("arg-id");
    });

    it("derives a stable id from hostname and working directory", () => {
        const a = resolveInstanceId({}, ["node", "x"], "/workspace/one");
        const b = resolveInstanceId({}, ["node", "x"], "/workspace/one");
        const c = resolveInstanceId({}, ["node", "x"], "/workspace/two");
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a.startsWith(`mcp-${os.hostname()}-`)).toBe(true);
    });

    it("keeps two WSL distributions on the same workspace apart, since they share the host name", () => {
        const ubuntu = resolveInstanceId({ WSL_DISTRO_NAME: "Ubuntu" }, ["node", "x"], "/home/u/proj", "claude-code");
        const debian = resolveInstanceId({ WSL_DISTRO_NAME: "Debian" }, ["node", "x"], "/home/u/proj", "claude-code");
        expect(ubuntu).not.toBe(debian);
        expect(resolveInstanceId({ WSL_DISTRO_NAME: "Ubuntu" }, ["node", "x"], "/home/u/proj", "claude-code")).toBe(ubuntu);
    });

    it("keeps two IDEs on the same workspace apart by client name", () => {
        const vscode = resolveInstanceId({}, ["node", "x"], "/w", "Visual Studio Code");
        const cli = resolveInstanceId({}, ["node", "x"], "/w", "claude-code");
        expect(vscode).not.toBe(cli);
        expect(vscode.endsWith("-visual-studio-code")).toBe(true);
        expect(resolveInstanceId({ NEXUS_INSTANCE_ID: "pinned" }, ["node", "x"], "/w", "ide")).toBe("pinned");
    });
});

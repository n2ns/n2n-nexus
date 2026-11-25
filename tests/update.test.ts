import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { updateGlobalClient } from "../src/cli/auto-update.js";
import { localHostCommand, runUpdate } from "../src/cli/update.js";

vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawnSync: vi.fn() }));
vi.mock("../src/cli/auto-update.js", () => ({ updateGlobalClient: vi.fn(), NotGlobalClientError: class extends Error {} }));

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
});

it("updates both installations through the one command and reports a host failure even if the client succeeds", async () => {
    const dir = path.resolve("example-host-dir");
    vi.stubEnv("PATH", dir);
    const binary = path.join(dir, process.platform === "win32" ? "n2n-nexus-host.exe" : "n2n-nexus-host");
    vi.spyOn(fs, "statSync").mockImplementation(file => {
        if (file !== binary) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => true } as fs.Stats;
    });
    expect(localHostCommand()).toEqual({ exe: binary, args: ["auto-update", "run"] });
    vi.mocked(spawnSync).mockReturnValue({ status: 1, signal: null, output: [], pid: 42, stdout: null, stderr: null });
    expect(await runUpdate([])).toBe(1);
    expect(spawnSync).toHaveBeenCalledWith(binary, ["auto-update", "run"], expect.anything());
    expect(updateGlobalClient).toHaveBeenCalledOnce();
});

it("updates the local client when the host runs on another machine", async () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    expect(await runUpdate([])).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(updateGlobalClient).toHaveBeenCalledOnce();
});

it("never executes a scheduler script from the user profile through the manual command", async () => {
    vi.spyOn(fs, "statSync").mockImplementation(file => {
        if (/[\\/]updates[\\/]host\.(sh|ps1)$/.test(String(file))) return { isFile: () => true } as fs.Stats;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(await runUpdate([])).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
});

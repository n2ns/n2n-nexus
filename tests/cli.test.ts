import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");

function runCli(args: string[]): Promise<{ stderr: string, stdout: string }> {
    return new Promise((resolve) => {
        const proc = spawn("node", [ENTRY_POINT, ...args], {
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stderr = "";
        let stdout = "";
        proc.stderr?.on("data", (data) => stderr += data.toString());
        proc.stdout?.on("data", (data) => stdout += data.toString());

        // We only wait for initial boot logs or a short timeout since it doesn't always exit
        const timeout = setTimeout(() => {
            proc.kill("SIGKILL");
            resolve({ stderr, stdout });
        }, 3000);

        proc.on("close", () => {
            clearTimeout(timeout);
            resolve({ stderr, stdout });
        });
    });
}

describe("CLI E2E (Real Binary)", () => {
    it("should accept custom instance id via --id", async () => {
        const { stderr } = await runCli(["--id", "custom-e2e-id"]);
        // The logs usually contain the instance ID
        expect(stderr).toContain("Nexus:custom-e2e-id");
    });

    it("should accept custom port via --port", async () => {
        const { stderr } = await runCli(["--port", "19999"]);
        expect(stderr).toContain("Port: 19999");
    });
});

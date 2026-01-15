import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const RX_SESSION_ESTABLISHED = /Session established/;

function spawnNexus(port: string, id: string): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const proc = spawn("node", [ENTRY_POINT, "--port", port, "--id", id], {
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"]
        });

        const output: string[] = [];
        proc.stderr?.on("data", (data) => {
            output.push(data.toString());
        });

        proc.stdout?.on("data", () => { });
        resolve({ process: proc, output });
    });
}

async function waitForLog(output: string[], pattern: RegExp, timeoutMs: number = 8000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (output.some(line => pattern.test(line))) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

describe("Guest Connection E2E (Real Processes)", () => {
    let processes: ChildProcess[] = [];
    const TEST_PORT = "17100";

    afterAll(() => {
        processes.forEach(p => p.kill("SIGKILL"));
    });

    it("should successfully connect Guest to Host via network", async () => {
        // 1. Start Host
        const h = await spawnNexus(TEST_PORT, "guest-test-host");
        processes.push(h.process);
        await waitForLog(h.output, /Role: HOST/);

        // 2. Start Guest
        const g = await spawnNexus(TEST_PORT, "guest-test-guest");
        processes.push(g.process);

        // 3. Verify Connection
        const connected = await waitForLog(g.output, RX_SESSION_ESTABLISHED);
        expect(connected).toBe(true);

        // 4. Verify Host log for guest joining
        const guestJoined = await waitForLog(h.output, /Guest Joined: guest-test-guest/);
        expect(guestJoined).toBe(true);
    });
});

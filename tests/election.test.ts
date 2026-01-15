import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const RX_ELECTION_HOST = /Role: HOST/;
const RX_ELECTION_GUEST = /Role: GUEST/;

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

describe("Election E2E (Real Processes)", () => {
    let processes: ChildProcess[] = [];
    const TEST_PORT = "17000";

    afterAll(() => {
        processes.forEach(p => p.kill("SIGKILL"));
    });

    it("should elect a Host on an empty port range", async () => {
        const { process, output } = await spawnNexus(TEST_PORT, "election-host");
        processes.push(process);

        const isHost = await waitForLog(output, RX_ELECTION_HOST);
        expect(isHost).toBe(true);

        // Verify only port 17000 is bound (Leakage check)
        const ssOutput = execSync(`ss -lntp | grep :${TEST_PORT}`).toString();
        expect(ssOutput).toContain(`pid=${process.pid}`);
    });

    it("should elect a Guest when a Host is already running", async () => {
        // Port 17000 is still held by the Host from previous test (if not killed)
        // Actually each test should be isolated.

        // Cleanup from previous test
        processes.forEach(p => p.kill("SIGKILL"));
        processes = [];

        // 1. Start Host
        const h = await spawnNexus(TEST_PORT, "e2e-host");
        processes.push(h.process);
        await waitForLog(h.output, RX_ELECTION_HOST);

        // 2. Start Guest
        const g = await spawnNexus(TEST_PORT, "e2e-guest");
        processes.push(g.process);

        const isGuest = await waitForLog(g.output, RX_ELECTION_GUEST);
        expect(isGuest).toBe(true);
    });

    it("should handle port fallback when multiple ports are partially busy", async () => {
        processes.forEach(p => p.kill("SIGKILL"));
        processes = [];

        // 1. Occupy 17000 with a dummy non-nexus server (manual socket)
        const dummy = spawn("node", ["-e", `require('http').createServer().listen(${TEST_PORT}, '0.0.0.0')`], { detached: true });
        processes.push(dummy);
        await new Promise(r => setTimeout(r, 1000));

        // 2. Start Nexus. It should see 17000 is busy and NOT Nexus, so try 17001.
        const n1 = await spawnNexus(TEST_PORT, "fallback-host");
        processes.push(n1.process);

        const isHost = await waitForLog(n1.output, RX_ELECTION_HOST);
        expect(isHost).toBe(true);
        expect(n1.output.join("\n")).toContain(`Port: ${parseInt(TEST_PORT) + 1}`);
    });
});

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

// Path to the compiled JS entry point
const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const RX_HOST_READY = /MCP Server connected via stdio/;
const RX_SESSION_ESTABLISHED = /Session established/;
const RX_ELECTION_HOST = /Role: HOST/;
const RX_ELECTION_GUEST = /Role: GUEST/;

// Helper to spawn a Nexus Node
function spawnNexus(args: string[], id: string): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("node", [ENTRY_POINT, ...args], {
            env: { ...process.env, "NEXUS_CHECK_INTERVAL": "100" }, // Faster checks
            stdio: ["pipe", "pipe", "pipe"]
        });

        const output: string[] = [];

        // Collect stderr (logs)
        proc.stderr?.on("data", (data) => {
            const line = data.toString();
            output.push(line);
            // console.log(`[${id}] ${line.trim()}`); // Uncomment for debug
        });

        // Collect stdout (draining to prevent block)
        proc.stdout?.on("data", (data) => {
            // Drain
        });

        // Resolve immediately so we can interact with it, 
        // but we attach the output array for checking later.
        resolve({ process: proc, output });
    });
}

// Helper: Wait for a specific log pattern in the output array
async function waitForLog(output: string[], pattern: RegExp, timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (output.some(line => pattern.test(line))) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

describe("Nexus Integration (E2E)", () => {
    let hostProc: ChildProcess;
    let guestProc: ChildProcess;
    const hostOutput: string[] = [];
    const guestOutput: string[] = [];

    // Ensure build exists
    beforeAll(() => {
        if (!fs.existsSync(ENTRY_POINT)) {
            throw new Error(`Build not found at ${ENTRY_POINT}. Run 'npm run build' first.`);
        }
    });

    afterAll(() => {
        // Cleanup
        if (hostProc) hostProc.kill();
        if (guestProc) guestProc.kill();
    });

    it("should start a Host successfully", async () => {
        // Start Process A (should become Host)
        // Use a specific high port to avoid collision
        const port = "15888";

        const host = await spawnNexus(["--port", port, "--id", "test-host"], "HOST");
        hostProc = host.process;
        Object.assign(hostOutput, host.output); // Link ref

        // Wait for it to announce itself as Host
        const isHost = await waitForLog(host.output, RX_ELECTION_HOST, 5000);
        expect(isHost).toBe(true);
    }, 10000);

    it("should start a Guest that connects to the Host", async () => {
        const port = "15888";

        // Start Process B (should become Guest)
        const guest = await spawnNexus(["--port", port, "--id", "test-guest"], "GUEST");
        guestProc = guest.process;
        Object.assign(guestOutput, guest.output);

        // Wait for it to announce Guest Role
        const isGuest = await waitForLog(guest.output, RX_ELECTION_GUEST, 5000);
        expect(isGuest).toBe(true);

        // Wait for session established log (from GuestClient)
        const connected = await waitForLog(guest.output, RX_SESSION_ESTABLISHED, 5000);
        expect(connected).toBe(true);
    }, 10000);
});

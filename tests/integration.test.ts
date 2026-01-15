import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

// Path to the compiled JS entry point
const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const RX_HOST_READY = /MCP Server connected via stdio/;
const RX_SESSION_ESTABLISHED = /Session established/;
const RX_ELECTION_HOST = /Nexus Hub Active\. Playing Host/;
const RX_ELECTION_GUEST = /Nexus Hub\] Guest Active/;

// Helper to spawn a Nexus Node
function spawnNexus(portStart: string, id: string): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve, reject) => {
        const portEnd = (parseInt(portStart) + 10).toString();
        const env = {
            ...process.env,
            "NEXUS_CHECK_INTERVAL": "100",
            NEXUS_PORT_START: portStart,
            NEXUS_PORT_END: portEnd,
            NEXUS_STORAGE: process.env.NEXUS_STORAGE || path.join(process.cwd(), "tests", "tmp", "integration-shared")
        };

        const proc = spawn("node", [ENTRY_POINT, "--id", id], {
            env,
            stdio: ["pipe", "pipe", "pipe"]
        });

        const output: string[] = [];

        // Collect stderr (logs)
        proc.stderr?.on("data", (data) => {
            const line = data.toString();
            output.push(line);
        });

        // Collect stdout (draining to prevent block)
        proc.stdout?.on("data", (data) => {
            // Drain
        });

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
        // Cleanup shared storage
        const storagePath = path.join(process.cwd(), "tests", "tmp", "integration-shared");
        if (fs.existsSync(storagePath)) {
            fs.rmSync(storagePath, { recursive: true, force: true });
        }
    });

    afterAll(() => {
        // Cleanup
        if (hostProc) hostProc.kill();
        if (guestProc) guestProc.kill();
    });

    it("should start a Host successfully", async () => {
        // Start Process A (should become Host)
        const port = "15888";

        const host = await spawnNexus(port, "test-host");
        hostProc = host.process;
        Object.assign(hostOutput, host.output); // Link ref

        // Wait for it to announce itself as Host
        // Update regex to match correct log
        const isHost = await waitForLog(host.output, /Nexus Hub Active\. Playing Host/, 5000);
        if (!isHost) {
            console.error("DEBUG - Host Output:\n", host.output.join(""));
        }
        expect(isHost).toBe(true);
    }, 10000);

    it("should start a Guest that connects to the Host", async () => {
        const port = "15888";

        // Start Process B (should become Guest)
        const guest = await spawnNexus(port, "test-guest");
        guestProc = guest.process;
        Object.assign(guestOutput, guest.output);

        // Wait for it to announce Guest Role
        const isGuest = await waitForLog(guest.output, RX_ELECTION_GUEST, 5000);
        if (!isGuest) {
            console.error("DEBUG - Guest Output:\n", guest.output.join(""));
        }
        expect(isGuest).toBe(true);

        // Wait for session established log (from GuestClient)
        const connected = await waitForLog(guest.output, RX_SESSION_ESTABLISHED, 5000);
        expect(connected).toBe(true);
    }, 10000);
});

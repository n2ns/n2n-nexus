import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const RX_ELECTION_HOST = /Nexus Hub Active\. Playing Host/;
const RX_ELECTION_GUEST = /Role: GUEST/;
const RX_SESSION_ESTABLISHED = /Session established/;

function spawnNexus(portStart: string, id: string): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const portEnd = (parseInt(portStart) + 10).toString();
        const env = {
            ...process.env,
            NEXUS_PORT_START: portStart,
            NEXUS_PORT_END: portEnd,
            NEXUS_STORAGE: process.env.NEXUS_STORAGE || path.join(process.cwd(), "tests", "tmp", "multi-instance-shared")
        };

        const proc = spawn("node", [ENTRY_POINT, "--id", id], {
            env,
            stdio: ["pipe", "pipe", "pipe"]
        });

        const output: string[] = [];
        proc.stderr?.on("data", (data) => {
            output.push(data.toString());
        });

        // Prevent stdout blocking
        proc.stdout?.on("data", () => { });

        resolve({ process: proc, output });
    });
}

async function waitForLog(output: string[], pattern: RegExp, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (output.some(line => pattern.test(line))) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

describe("Nexus Real-World Multi-Instance E2E", () => {
    const TEST_PORT = "16888";
    let processes: ChildProcess[] = [];

    beforeAll(() => {
        if (!fs.existsSync(ENTRY_POINT)) {
            throw new Error("Build missing. Run 'npm run build' first.");
        }
        // Cleanup shared storage
        const storagePath = path.join(process.cwd(), "tests", "tmp", "multi-instance-shared");
        if (fs.existsSync(storagePath)) {
            fs.rmSync(storagePath, { recursive: true, force: true });
        }
    });

    afterAll(() => {
        processes.forEach(p => p.kill("SIGKILL"));
    });

    it("should coordinate 3 simultaneous instances: 1 Host and 2 Guests", async () => {
        // 1. Spawn 3 instances nearly simultaneously
        const n1 = await spawnNexus(TEST_PORT, "instance-1");
        const n2 = await spawnNexus(TEST_PORT, "instance-2");
        const n3 = await spawnNexus(TEST_PORT, "instance-3");

        processes.push(n1.process, n2.process, n3.process);

        // 2. Wait for all to finish election
        await Promise.all([
            waitForLog(n1.output, /Role:/),
            waitForLog(n2.output, /Role:/),
            waitForLog(n3.output, /Role:/)
        ]);

        const roles = [
            n1.output.some(l => RX_ELECTION_HOST.test(l)) ? "HOST" : "GUEST",
            n2.output.some(l => RX_ELECTION_HOST.test(l)) ? "HOST" : "GUEST",
            n3.output.some(l => RX_ELECTION_HOST.test(l)) ? "HOST" : "GUEST"
        ];

        // 3. Assert exactly one Host and two Guests
        const hostCount = roles.filter(r => r === "HOST").length;
        const guestCount = roles.filter(r => r === "GUEST").length;

        try {
            expect(hostCount).toBe(1);
            expect(guestCount).toBe(2);

            // 4. Verify Guests established sessions
            const guests = [n1, n2, n3].filter((_, i) => roles[i] === "GUEST");
            for (const g of guests) {
                const connected = await waitForLog(g.output, RX_SESSION_ESTABLISHED, 5000);
                expect(connected).withContext(`Guest ${g.process.pid} failed to establish session`).toBe(true);
            }
        } catch (e) {
            console.error("DEBUG - Instance 1 Output:\n", n1.output.join(""));
            console.error("DEBUG - Instance 2 Output:\n", n2.output.join(""));
            console.error("DEBUG - Instance 3 Output:\n", n3.output.join(""));
            throw e;
        }

        // 5. CRITICAL: CHECK FOR PORT LEAKAGE
        // In Linux, we can use 'ss' to check who is listening on the port.
        try {
            const ssOutput = execSync(`ss -lntp | grep :${TEST_PORT}`).toString();
            const listenLines = ssOutput.trim().split("\n");

            // Should only be ONE line for this port being in LISTEN state
            // (Note: SS output might show multiple lines if listening on both ipv4 and ipv6, 
            // but Nexus binds to 0.0.0.0 by default)
            expect(listenLines.length).toBeLessThanOrEqual(2);

            // Verify PID of the listener matches our Host
            const hostIndex = roles.indexOf("HOST");
            const hostPid = processes[hostIndex].pid;
            expect(ssOutput).toContain(`pid=${hostPid}`);

            // Ensure 16889 and 16890 are NOT bound (Leakage check)
            try {
                execSync(`ss -lntp | grep :${parseInt(TEST_PORT) + 1}`);
                throw new Error("Port 16889 is unexpectedly bound!");
            } catch (e: any) {
                // Expecting exit code 1 (not found)
                if (e.message.includes("unexpectedly bound")) throw e;
            }
        } catch (e) {
            if (process.platform === "linux") throw e;
            console.warn("Skipping 'ss' check on non-linux platform");
        }
    }, 30000);
});

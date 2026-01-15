import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "e2e-permissions-storage");

function spawnNexus(id: string, port?: number): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const args = ["node", ENTRY_POINT, "--id", id];
        if (port) args.push("--port", port.toString());

        const proc = spawn(args[0], args.slice(1), {
            env: { ...process.env, NEXUS_STORAGE: TEST_ROOT, NEXUS_PORT_START: "15000", NEXUS_PORT_END: "15010" },
            stdio: ["pipe", "pipe", "pipe"]
        });

        const output: string[] = [];
        proc.stderr?.on("data", (data) => {
            output.push(data.toString());
        });

        resolve({ process: proc, output });
    });
}

function sendRequest(proc: ChildProcess, method: string, params: any, id: string = "req-1") {
    proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

async function waitForResponse(proc: ChildProcess, id: string, timeoutMs: number = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response ${id}`)), timeoutMs);
        const onData = (data: Buffer) => {
            const lines = data.toString().split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (json.id === id) {
                        proc.stdout?.removeListener("data", onData);
                        clearTimeout(timeout);
                        resolve(json);
                    }
                } catch { }
            }
        };
        proc.stdout?.on("data", onData);
    });
}

describe("Permissions E2E (Real Processes)", () => {
    let proc: ChildProcess;
    let output: string[];
    const TEST_PORT = 15000;

    beforeAll(async () => {
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        fs.mkdirSync(TEST_ROOT, { recursive: true });

        const n = await spawnNexus("perm-host", TEST_PORT);
        proc = n.process;
        output = n.output;
        // Wait for Role: HOST
        const start = Date.now();
        while (Date.now() - start < 8000) {
            if (output.some(l => l.includes("Role: HOST"))) break;
            await new Promise(r => setTimeout(r, 100));
        }
    });

    afterAll(() => {
        if (proc) proc.kill("SIGKILL");
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it("should allow host to perform sensitive actions", async () => {
        // Host (this process) should be able to clear global logs
        sendRequest(proc, "tools/call", {
            name: "host_maintenance",
            arguments: { action: "clear", count: 0 }
        }, "perm-1");

        const resp = await waitForResponse(proc, "perm-1");
        expect(resp.result.content[0].text).toContain("wiped");
    });

    it("should reject non-host from performing sensitive actions", async () => {
        // 1. Start a Guest process (It will find the host via TEST_ROOT's election info)
        const g = await spawnNexus("perm-guest");
        const gProc = g.process;

        // 2. Wait for Guest to join
        const start = Date.now();
        let joined = false;
        while (Date.now() - start < 10000) {
            // Check Guest's output for Role: GUEST
            if (g.output.some(l => l.includes("Role: GUEST"))) {
                joined = true;
                break;
            }
            // Check Host's output for Guest Joined
            if (output.some(l => l.includes("Guest Joined"))) {
                joined = true;
                break;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        if (!joined) {
            console.error("Guest Output:", g.output);
            console.error("Host Output:", output);
            throw new Error("Guest failed to join host");
        }

        // 3. Send a host-only tool call to the GUEST's Stdio
        // The Guest should forward it, and the Host should reject it because the source is SSE.
        sendRequest(gProc, "tools/call", {
            name: "host_maintenance",
            arguments: { action: "clear", count: 0 }
        }, "perm-guest-1");

        const resp = await waitForResponse(gProc, "perm-guest-1");
        expect(resp.result.content[0].text).toContain("Permission Denied");

        gProc.kill("SIGKILL");
    }, 15000);
});

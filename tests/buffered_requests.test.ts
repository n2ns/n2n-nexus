
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

// Path to the compiled JS entry point
const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");

function spawnNexus(args: string[]): ChildProcess {
    return spawn("node", [ENTRY_POINT, ...args], {
        env: { ...process.env, "NEXUS_CHECK_INTERVAL": "100" },
        stdio: ["pipe", "pipe", "pipe"]
    });
}

describe("Buffered Requests (Immediate Handshake)", () => {
    let proc: ChildProcess;
    const outputBuffer: string[] = [];

    beforeAll(() => {
        if (!fs.existsSync(ENTRY_POINT)) {
            throw new Error(`Build not found at ${ENTRY_POINT}. Run 'npm run build' first.`);
        }
    });

    afterAll(() => {
        if (proc) proc.kill();
    });

    it("should buffer tools/list request sent immediately after spawn", async () => {
        // 1. Spawn Nexus
        // Use a strict custom ID to ensure no interference
        proc = spawnNexus(["--id", "buffer-test"]);

        // 2. IMMEDIATELY write a JSON-RPC request to Stdin
        // This attempts to call 'tools/list' before election could possibly finish
        const request = {
            jsonrpc: "2.0",
            id: "buffer-req-1",
            method: "tools/list"
        };

        // We write directly to stdin. The server should receive this, see election !done, and buffer it.
        const stdin = proc.stdin;
        if (stdin) {
            stdin.write(JSON.stringify(request) + "\n");
        } else {
            throw new Error("Stdin not available");
        }

        // 3. Listen for response
        // We expect a valid JSON-RPC response with tools list
        let foundResponse = false;

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timeout waiting for buffered response"));
            }, 5000); // 5s timeout

            proc.stdout?.on("data", (data) => {
                const lines = data.toString().split("\n");
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        // Check if this is the response to our ID
                        if (json.id === "buffer-req-1" && json.result && json.result.tools) {
                            foundResponse = true;
                            clearTimeout(timeout);
                            resolve();
                        }
                    } catch {
                        // Ignore non-JSON logs
                    }
                }
            });

            proc.stderr?.on("data", (data) => {
                // console.log(`[STDERR] ${data}`); // Debug only
            });
        });

        expect(foundResponse).toBe(true);
    });
});

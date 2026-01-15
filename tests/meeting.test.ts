import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "e2e-meetings-storage");

function spawnNexus(): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const proc = spawn("node", [ENTRY_POINT], {
            env: { ...process.env, NEXUS_STORAGE: TEST_ROOT },
            stdio: ["pipe", "pipe", "pipe"]
        });
        const output: string[] = [];
        proc.stderr?.on("data", (data) => output.push(data.toString()));
        resolve({ process: proc, output });
    });
}

function sendRequest(proc: ChildProcess, method: string, params: any, id: string = "req-1") {
    proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

async function waitForResponse(proc: ChildProcess, id: string, timeoutMs: number = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout response ${id}`)), timeoutMs);
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

describe("Meetings E2E (Real Processes)", () => {
    let proc: ChildProcess;
    let output: string[];

    beforeAll(async () => {
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        const n = await spawnNexus();
        proc = n.process;
        output = n.output;
        const start = Date.now();
        while (Date.now() - start < 5000) {
            if (output.some(l => l.includes("Role: HOST"))) break;
            await new Promise(r => setTimeout(r, 100));
        }

        // Initial setup - skip project sync for brevity if not needed
    });

    afterAll(() => {
        if (proc) proc.kill("SIGKILL");
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it("should handle meeting lifecycle: start -> send_message -> end", async () => {
        // 1. Start Meeting
        sendRequest(proc, "tools/call", {
            name: "start_meeting",
            arguments: { topic: "E2E Meeting" }
        }, "m-start");
        const startResp = await waitForResponse(proc, "m-start");
        let startData;
        try {
            startData = JSON.parse(startResp.result.content[0].text);
        } catch (e) {
            console.error("DEBUG - Raw Response:", startResp.result.content[0].text);
            console.error("DEBUG - Host Output:", output.join(""));
            throw e;
        }
        const meetingId = startData.meetingId;
        expect(meetingId).toBeDefined();

        // 2. Send Message
        sendRequest(proc, "tools/call", {
            name: "send_message",
            arguments: { message: "E2E Note", category: "PROPOSAL" }
        }, "m-msg");
        await waitForResponse(proc, "m-msg");

        // 3. End Meeting
        sendRequest(proc, "tools/call", {
            name: "end_meeting",
            arguments: { meetingId, summary: "Done" }
        }, "m-end");
        const endResp = await waitForResponse(proc, "m-end");
        try {
            expect(JSON.parse(endResp.result.content[0].text).status).toBe("closed");
        } catch (e) {
            console.error("DEBUG - Raw End Response:", endResp.result.content[0].text);
            console.error("DEBUG - Host Output:", output.join(""));
            throw e;
        }
    });
});

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "e2e-tasks-storage");

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

describe("Tasks E2E (Real Processes)", () => {
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
    });

    afterAll(() => {
        if (proc) proc.kill("SIGKILL");
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it("should handle full task lifecycle: create -> update -> get", async () => {
        // 1. Create
        sendRequest(proc, "tools/call", {
            name: "create_task",
            arguments: { metadata: { step: "boot" } }
        }, "task-c");
        const cResp = await waitForResponse(proc, "task-c");
        const cData = JSON.parse(cResp.result.content[0].text);
        const taskId = cData.task_id;
        expect(taskId).toBeDefined();

        // 2. Update
        sendRequest(proc, "tools/call", {
            name: "update_task",
            arguments: { taskId, status: "running", progress: 0.5 }
        }, "task-u");
        await waitForResponse(proc, "task-u");

        // 3. Get
        sendRequest(proc, "tools/call", {
            name: "get_task",
            arguments: { taskId }
        }, "task-g");
        const gResp = await waitForResponse(proc, "task-g");
        const task = JSON.parse(gResp.result.content[0].text);
        expect(task.status).toBe("running");
        expect(task.progress).toBe(0.5);
    });
});

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "e2e-search-storage");

function spawnNexus(): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const proc = spawn("node", [ENTRY_POINT], {
            env: { ...process.env, NEXUS_STORAGE: TEST_ROOT },
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

describe("Search E2E (Real Processes)", () => {
    let proc: ChildProcess;
    let output: string[];

    beforeAll(async () => {
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        fs.mkdirSync(TEST_ROOT, { recursive: true });

        const n = await spawnNexus();
        proc = n.process;
        output = n.output;

        // Wait for Role: HOST
        const start = Date.now();
        while (Date.now() - start < 5000) {
            if (output.some(l => l.includes("Role: HOST"))) break;
            await new Promise(r => setTimeout(r, 100));
        }

        // 1. MUST register session context first
        sendRequest(proc, "tools/call", {
            name: "register_session_context",
            arguments: { projectId: "api_e2e_search" }
        }, "reg-1");
        await waitForResponse(proc, "reg-1");

        // 2. Seed some projects using sync_project_assets
        const projects = [
            { id: "web_app", name: "Web Frontend", stack: ["React"] },
            { id: "api_srv", name: "Backend API", stack: ["Node"] }
        ];

        for (const p of projects) {
            const seedId = `seed-${p.id}`;
            sendRequest(proc, "tools/call", {
                name: "sync_project_assets",
                arguments: {
                    manifest: {
                        id: p.id,
                        name: p.name,
                        description: `Description for ${p.name}`,
                        techStack: p.stack,
                        relations: [],
                        lastUpdated: new Date().toISOString(),
                        repositoryUrl: "",
                        localPath: path.join(TEST_ROOT, "dummy-code", p.id),
                        endpoints: [],
                        apiSpec: []
                    },
                    internalDocs: `# Implementation details for ${p.name}`
                }
            }, seedId);
            // Ensure localPath exists
            fs.mkdirSync(path.join(TEST_ROOT, "dummy-code", p.id), { recursive: true });
            const seedResp = await waitForResponse(proc, seedId);
            const seedMsg = seedResp.result.content[0].text;
            const taskIdMatch = seedMsg.match(/task_[a-z0-9_]+/);
            if (taskIdMatch) {
                const taskId = taskIdMatch[0];
                // Poll for completion
                let completed = false;
                for (let i = 0; i < 20; i++) {
                    sendRequest(proc, "tools/call", { name: "get_task", arguments: { taskId } }, `poll-${seedId}-${i}`);
                    const pollResp = await waitForResponse(proc, `poll-${seedId}-${i}`);
                    const task = JSON.parse(pollResp.result.content[0].text);
                    if (task.status === "completed") {
                        completed = true;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                if (!completed) throw new Error(`Sync task ${taskId} timed out`);
            }
        }
    });

    afterAll(() => {
        if (proc) proc.kill("SIGKILL");
        if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it("should find backend project by keyword", async () => {
        sendRequest(proc, "tools/call", {
            name: "search_projects",
            arguments: { query: "Backend" }
        }, "search-1");

        const resp = await waitForResponse(proc, "search-1");
        const data = JSON.parse(resp.result.content[0].text);
        expect(data.count).toBe(1);
        expect(data.results[0].id).toBe("api_srv");
    });
});

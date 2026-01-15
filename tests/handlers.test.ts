import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const ENTRY_POINT = path.resolve(__dirname, "../build/index.js");
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "e2e-tools-storage");

function spawnNexus(): Promise<{ process: ChildProcess, output: string[] }> {
    return new Promise((resolve) => {
        const proc = spawn("node", [ENTRY_POINT, "--id", "tools-e2e-node"], {
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
    const payload = {
        jsonrpc: "2.0",
        id,
        method,
        params
    };
    proc.stdin?.write(JSON.stringify(payload) + "\n");
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

describe("Tools E2E (Real Processes via Stdin)", () => {
    let proc: ChildProcess;
    let output: string[];

    beforeAll(async () => {
        if (fs.existsSync(TEST_ROOT)) {
            fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        }
        const n = await spawnNexus();
        proc = n.process;
        output = n.output;

        // Wait for boot
        const start = Date.now();
        while (Date.now() - start < 5000) {
            if (output.some(l => l.includes("Role: HOST"))) break;
            await new Promise(r => setTimeout(r, 100));
        }
    });

    afterAll(() => {
        if (proc) proc.kill("SIGKILL");
        if (fs.existsSync(TEST_ROOT)) {
            fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        }
    });

    it("should handle register_session_context via JSON-RPC", async () => {
        sendRequest(proc, "tools/call", {
            name: "register_session_context",
            arguments: { projectId: "api_e2e_test_proj" }
        }, "reg-1");

        const resp = await waitForResponse(proc, "reg-1");
        expect(resp.result.content[0].text).toContain("api_e2e_test_proj");
    });

    it("should handle sync_project_assets via JSON-RPC", async () => {
        sendRequest(proc, "tools/call", {
            name: "sync_project_assets",
            arguments: {
                manifest: {
                    id: "api_e2e_test_proj",
                    name: "E2E Test",
                    description: "D",
                    techStack: ["Node"],
                    relations: [],
                    lastUpdated: new Date().toISOString(),
                    repositoryUrl: "",
                    localPath: TEST_ROOT,
                    endpoints: [],
                    apiSpec: []
                },
                internalDocs: "# Hello E2E"
            }
        }, "sync-1");

        const resp = await waitForResponse(proc, "sync-1");
        expect(resp.result.content[0].text).toContain("Sync task created");
    });

    it("should handle send_message via JSON-RPC", async () => {
        sendRequest(proc, "tools/call", {
            name: "send_message",
            arguments: { message: "Hello from E2E Stdin", category: "UPDATE" }
        }, "msg-1");

        const resp = await waitForResponse(proc, "msg-1");
        expect(resp.result.content[0].text).toContain("Sent message");

        // Verify persistent log exists
        const logFile = path.join(TEST_ROOT, "global", "discussion.json");
        expect(fs.existsSync(logFile)).toBe(true);
        const logs = JSON.parse(fs.readFileSync(logFile, "utf-8"));
        expect(logs.some((l: any) => l.text === "Hello from E2E Stdin")).toBe(true);
    });
});

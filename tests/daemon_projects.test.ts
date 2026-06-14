import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { promises as fs } from "fs";
import path from "path";

import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { getTask, listTasks } from "../src/storage/tasks.js";
import { NexusPaths } from "../src/storage/paths.js";
import { ProjectManifest } from "../src/types.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "daemon-projects");
const API_BASE_PORT = 0;

type DaemonHarness = {
    port: number;
    close: () => Promise<void>;
};

function requestJson<T>(base: string, method: string, route: string, body?: unknown): Promise<{ status: number; payload: T }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                method,
                hostname: "127.0.0.1",
                port: Number(base),
                path: route,
                headers: {
                    "Content-Type": "application/json",
                    ...(body ? { "Content-Length": Buffer.byteLength(JSON.stringify(body)) } : {})
                }
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        resolve({
                            status: res.statusCode || 0,
                            payload: data ? (JSON.parse(data) as T) : ({} as T)
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        req.on("error", reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function waitForTask(taskId: string, timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (Date.now() - started < timeoutMs) {
        const task = getTask(taskId);
        if (Date.now() - started > 500) {
            const all = listTasks();
            console.log("[DAEMON TEST] All tasks:", all.map((t) => `${t.id}:${t.status}`));
            console.log("[DAEMON TEST] Waiting task:", taskId, "status", task?.status, "since", Date.now() - started);
        }
        if (task && (task.status === "completed" || task.status === "failed")) {
            if (task.status === "failed") {
                throw new Error(`Task failed: ${task.error_message}`);
            }
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} did not finish in time`);
}

async function startDaemon(): Promise<DaemonHarness> {
    const { server } = await createDaemonServer({
        port: API_BASE_PORT,
        version: "test"
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.once("error", reject);
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
        throw new Error("Daemon address not ready");
    }
    const port = (addr as AddressInfo).port;

    return {
        port,
        close: () => new Promise((resolve) => server.close(() => resolve()))
    };
}

describe("Daemon project write API", () => {
    let daemon: DaemonHarness | null = null;

    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        StorageManager.resetInit();
        daemon = await startDaemon();
    });

    afterEach(async () => {
        await daemon?.close();
        daemon = null;
        closeDatabase();
    });

    it("sync_project_assets -> update_project -> rename_project -> delete_project: one source of truth", async () => {
        const manifestA: ProjectManifest = {
            id: "proj-demo",
            name: "Demo Project",
            description: "Original",
            techStack: ["node"],
            relations: [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: "https://example.com/demo",
            localPath: path.join(TEST_ROOT, "demo"),
            endpoints: [{ name: "api", url: "http://localhost:3000", description: "main" }],
            apiSpec: [{ method: "GET", path: "/health", summary: "health" }]
        };
        await fs.mkdir(manifestA.localPath, { recursive: true });

        const sync = await requestJson<{ ok: boolean; task_id: string; status: string }>(daemon!.port.toString(), "POST", "/api/projects/sync", {
            manifest: manifestA,
            internalDocs: "# Internal Notes",
            projectId: manifestA.id,
            instanceId: "ide-a"
        });
        expect(sync.status).toBe(200);
        expect(sync.payload.ok).toBe(true);
        await waitForTask(sync.payload.task_id);

        const syncedManifest = await StorageManager.getProjectManifest("proj-demo");
        expect(syncedManifest?.id).toBe("proj-demo");
        const syncedDocs = await StorageManager.getProjectDocs("proj-demo");
        expect(syncedDocs).toContain("Internal Notes");

        const update = await requestJson<{ ok: boolean; task_id: string; status: string }>(daemon!.port.toString(), "POST", "/api/projects/update", {
            projectId: "proj-demo",
            patch: { description: "Updated" },
            instanceId: "ide-a"
        });
        expect(update.status).toBe(200);
        await waitForTask(update.payload.task_id);
        const updated = await StorageManager.getProjectManifest("proj-demo");
        expect(updated?.description).toBe("Updated");

        const rename = await requestJson<{ ok: boolean; task_id: string; status: string }>(daemon!.port.toString(), "POST", "/api/projects/rename", {
            oldId: "proj-demo",
            newId: "proj-demo-renamed",
            instanceId: "ide-a"
        });
        expect(rename.status).toBe(200);
        await waitForTask(rename.payload.task_id);
        expect(await StorageManager.getProjectManifest("proj-demo")).toBeNull();
        expect(await StorageManager.getProjectManifest("proj-demo-renamed")).not.toBeNull();
        const expectedDocPath = path.join(NexusPaths.projectDocPath("proj-demo-renamed"));
        expect(await StorageManager.exists(expectedDocPath)).toBe(true);

        const remove = await requestJson<{ ok: boolean; task_id: string; status: string }>(daemon!.port.toString(), "POST", "/api/projects/delete", {
            projectId: "proj-demo-renamed",
            instanceId: "ide-a"
        });
        expect(remove.status).toBe(200);
        await waitForTask(remove.payload.task_id);
        expect(await StorageManager.getProjectManifest("proj-demo-renamed")).toBeNull();
        expect(await StorageManager.exists(path.join(StorageManager.projectsRoot, "proj-demo-renamed"))).toBe(false);
    });
});

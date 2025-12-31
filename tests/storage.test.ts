import { describe, it, expect, beforeEach } from "vitest";
import { StorageManager } from "../src/storage/index.js";
import { ProjectManifest } from "../src/types.js";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../src/config.js";

// Mock fs and CONFIG if needed, or use a temp test directory
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-storage");
CONFIG.rootStorage = TEST_ROOT;

describe("StorageManager", () => {
    beforeEach(async () => {
        // Clean up and re-init with proper delay for filesystem sync
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {
            // Ignore clean up errors
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        // Create root directory first to avoid race condition
        await fs.mkdir(TEST_ROOT, { recursive: true });
        await StorageManager.init();
    });

    it("should initialize storage structure", async () => {
        expect(await StorageManager.exists(StorageManager.globalDir)).toBe(true);
        expect(await StorageManager.exists(StorageManager.projectsRoot)).toBe(true);
        expect(await StorageManager.exists(StorageManager.registryFile)).toBe(true);
    });

    it("should save and retrieve project manifest", async () => {
        const manifest: ProjectManifest = {
            id: "test-p",
            name: "Test Project",
            description: "Desc",
            techStack: ["Node"],
            relations: [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: "https://github.com/test",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        };
        await StorageManager.saveProjectManifest(manifest);
        const retrieved = await StorageManager.getProjectManifest("test-p");
        expect(retrieved?.name).toBe("Test Project");
    });

    it("should add logs to global discussion", async () => {
        await StorageManager.addGlobalLog("AI", "Hello World");
        const logs = JSON.parse(await fs.readFile(StorageManager.globalDiscussion, "utf-8"));
        expect(logs).toHaveLength(1);
        expect(logs[0].text).toBe("Hello World");
    });

    it("should prune logs", async () => {
        await StorageManager.addGlobalLog("A", "1");
        await StorageManager.addGlobalLog("A", "2");
        await StorageManager.addGlobalLog("A", "3");
        await StorageManager.pruneGlobalLogs(1);
        const logs = JSON.parse(await fs.readFile(StorageManager.globalDiscussion, "utf-8"));
        expect(logs).toHaveLength(2);
        expect(logs[0].text).toBe("2");
    });

    it("should save and retrieve assets", async () => {
        const content = Buffer.from("fake-image-data");
        const relPath = await StorageManager.saveAsset("test-p", "logo.png", content);
        expect(relPath).toContain("logo.png");
        const exists = await StorageManager.exists(path.join(TEST_ROOT, relPath));
        expect(exists).toBe(true);
    });

    it("should save and retrieve internal docs", async () => {
        const doc = "# Tech Doc";
        await StorageManager.saveProjectDocs("test-p", doc);
        const retrieved = await StorageManager.getProjectDocs("test-p");
        expect(retrieved).toBe(doc);
    });

    it("should calculate global topology", async () => {
        // Create Project A
        await StorageManager.saveProjectManifest({
            id: "prj-a", name: "A", description: "D", techStack: [],
            relations: [{ targetId: "prj-b", type: "dependency" }],
            lastUpdated: "",
            repositoryUrl: "",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        });
        // Create Project B
        await StorageManager.saveProjectManifest({
            id: "prj-b", name: "B", description: "D", techStack: [],
            relations: [], lastUpdated: "",
            repositoryUrl: "",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        });

        const topo = await StorageManager.calculateTopology();
        expect(topo.nodes).toHaveLength(2);
        expect(topo.edges).toHaveLength(1);
        expect(topo.edges[0]).toMatchObject({ from: "prj-a", to: "prj-b", type: "dependency" });
    });

    it("should delete project correctly", async () => {
        await StorageManager.saveProjectManifest({
            id: "prj-del", name: "D", description: "D", techStack: [],
            relations: [], lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
        });
        
        expect(await StorageManager.getProjectManifest("prj-del")).not.toBeNull();
        
        await StorageManager.deleteProject("prj-del");
        
        expect(await StorageManager.getProjectManifest("prj-del")).toBeNull();
        const exists = await StorageManager.exists(path.join(StorageManager.projectsRoot, "prj-del"));
        expect(exists).toBe(false);
    });
});

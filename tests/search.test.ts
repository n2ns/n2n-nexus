
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleToolCall } from "../src/tools/index.js";
import { StorageManager } from "../src/storage/index.js";
import { CONFIG } from "../src/config/index.js";
import { promises as fs } from "fs";
import path from "path";

describe("Tool: search_projects", () => {
    const TEST_STORAGE = path.join(process.cwd(), "test-storage-search");

    beforeAll(async () => {
        // Setup isolated storage
        CONFIG.rootStorage = TEST_STORAGE;
        await StorageManager.init();

        // Seed some projects
        await StorageManager.saveProjectManifest({
            id: "web-dashboard",
            name: "Web Dashboard",
            description: "A React-based dashboard for analytics.",
            techStack: ["React", "TypeScript"],
            relations: [],
            repositoryUrl: "",
            localPath: "/tmp/web-dash",
            endpoints: [],
            apiSpec: []
        });

        await StorageManager.saveProjectManifest({
            id: "api-service",
            name: "Backend API",
            description: "Node.js API service.",
            techStack: ["Node.js", "Express"],
            relations: [],
            repositoryUrl: "",
            localPath: "/tmp/api-srv",
            endpoints: [],
            apiSpec: []
        });
    });

    afterAll(async () => {
        await fs.rm(TEST_STORAGE, { recursive: true, force: true });
    });

    it("should find projects by name", async () => {
        const result = await handleToolCall("search_projects", { query: "Dashboard" }, {
            currentProject: null,
            setCurrentProject: () => { },
            notifyResourceUpdate: () => { }
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(1);
        expect(data.results[0].id).toBe("web-dashboard");
    });

    it("should find projects by description", async () => {
        const result = await handleToolCall("search_projects", { query: "Node.js" }, {
            currentProject: null,
            setCurrentProject: () => { },
            notifyResourceUpdate: () => { }
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(1);
        expect(data.results[0].id).toBe("api-service");
    });

    it("should return empty list for no matches", async () => {
        const result = await handleToolCall("search_projects", { query: "NonExistent" }, {
            currentProject: null,
            setCurrentProject: () => { },
            notifyResourceUpdate: () => { }
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(0);
    });

    it("should be case insensitive", async () => {
        const result = await handleToolCall("search_projects", { query: "backend" }, {
            currentProject: null,
            setCurrentProject: () => { },
            notifyResourceUpdate: () => { }
        });

        const data = JSON.parse(result.content[0].text);
        expect(data.count).toBe(1);
        expect(data.results[0].id).toBe("api-service");
    });
});

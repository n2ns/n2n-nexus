import { promises as fs } from "fs";
import { ProjectManifest } from "../types.js";
import { FILE_ENCODING } from "../constants.js";

import { NexusPaths } from "./paths.js";
import { RegistryStorage } from "./registry.js";
import { ProjectStorage } from "./projects.js";
import { LogStorage } from "./logs.js";
import { DocStorage } from "./docs.js";

export class StorageManager {
    private static initialized = false;

    // --- Path Proxies (Backward Compatibility) ---
    static get globalDir() { return NexusPaths.globalDir; }
    static get globalBlueprint() { return NexusPaths.globalBlueprint; }
    static get globalDiscussion() { return NexusPaths.globalDiscussion; }
    static get projectsRoot() { return NexusPaths.projectsRoot; }
    static get registryFile() { return NexusPaths.registryFile; }
    static get archivesDir() { return NexusPaths.archivesDir; }

    static async init() {
        if (this.initialized) return;

        await fs.mkdir(NexusPaths.root, { recursive: true });
        await fs.mkdir(this.globalDir, { recursive: true });
        await fs.mkdir(this.projectsRoot, { recursive: true });
        await fs.mkdir(this.archivesDir, { recursive: true });

        // Self-healing initialization for critical files
        await this.loadJsonSafe(this.registryFile, { projects: {} });
        await this.loadJsonSafe(this.globalDiscussion, []);

        if (!await this.exists(this.globalBlueprint)) {
            await fs.writeFile(this.globalBlueprint, "# Global Coordination Blueprint\n\nShared meeting space.");
        }

        await DocStorage.init();

        try {
            const { initTasksTable } = await import("./tasks.js");
            initTasksTable();
        } catch {
            /* tasks module is optional */
        }

        this.initialized = true;
    }

    static resetInit() {
        this.initialized = false;
    }

    private static async loadJsonSafe<T>(filePath: string, defaultValue: T): Promise<T> {
        try {
            if (!await this.exists(filePath)) {
                await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), FILE_ENCODING);
                return defaultValue;
            }
            const content = await fs.readFile(filePath, FILE_ENCODING);
            return JSON.parse(content.replace(/^\uFEFF/, '').trim());
        } catch {
            console.warn(`[Nexus Storage] Repairing corrupted file: ${filePath}`);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), FILE_ENCODING);
            return defaultValue;
        }
    }

    static async exists(p: string) {
        try { await fs.access(p); return true; } catch { return false; }
    }

    // --- Registry Methods ---
    static listRegistry() { return RegistryStorage.listRegistry(); }
    static getProjectManifest(id: string) { return RegistryStorage.getProjectManifest(id); }
    static saveProjectManifest(manifest: ProjectManifest) { return RegistryStorage.saveProjectManifest(manifest); }
    static patchProjectManifest(id: string, patch: Partial<ProjectManifest>) { return RegistryStorage.patchProjectManifest(id, patch); }
    static calculateTopology(projectId?: string) { return RegistryStorage.calculateTopology(projectId); }

    // --- Project Methods ---
    static getProjectDocs(id: string) { return ProjectStorage.getProjectDocs(id); }
    static saveProjectDocs(id: string, content: string) { return ProjectStorage.saveProjectDocs(id, content); }
    static saveAsset(id: string, fileName: string, content: string | Buffer) { return ProjectStorage.saveAsset(id, fileName, content); }
    static async deleteProject(id: string) {
        await ProjectStorage.deleteProject(id);
        await RegistryStorage.deleteProject(id);
    }
    static async renameProject(oldId: string, newId: string) {
        await RegistryStorage.renameProject(oldId, newId);
        try {
            const result = await ProjectStorage.renameProject(oldId, newId);
            if (result === 0) {
                await RegistryStorage.renameProject(newId, oldId);
            }
            return result;
        } catch (error) {
            await RegistryStorage.renameProject(newId, oldId).catch(() => { });
            throw error;
        }
    }

    // --- Log Methods ---
    static addGlobalLog(from: string, text: string, category?: string) { return LogStorage.addLog(from, text, category); }
    static getRecentLogs(count: number = 10) { return LogStorage.getLogs(count); }
    static pruneGlobalLogs(count: number) { return LogStorage.pruneLogs(count); }
    static clearGlobalLogs() { return LogStorage.clearLogs(); }

    // --- Doc Methods ---
    static listGlobalDocs() { return DocStorage.listDocs(); }
    static getGlobalDoc(docId: string) { return DocStorage.getDoc(docId); }
    static saveGlobalDoc(docId: string, title: string, content: string, updatedBy: string) { return DocStorage.saveDoc(docId, title, content, updatedBy); }
    static deleteGlobalDoc(docId: string) { return DocStorage.deleteDoc(docId); }
}

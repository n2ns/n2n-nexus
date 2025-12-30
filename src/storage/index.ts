import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { DiscussionMessage, ProjectManifest, Registry } from "../types.js";
import { AsyncMutex } from "../utils/async-mutex.js";

export class StorageManager {
    // --- Concurrency Control ---
    private static discussionLock = new AsyncMutex();
    private static registryLock = new AsyncMutex();
    // --- Path Definitions ---
    static get globalDir() { return path.join(CONFIG.rootStorage, "global"); }
    static get globalBlueprint() { return path.join(this.globalDir, "blueprint.md"); }
    static get globalDiscussion() { return path.join(this.globalDir, "discussion.json"); }

    static get projectsRoot() { return path.join(CONFIG.rootStorage, "projects"); }
    static get registryFile() { return path.join(CONFIG.rootStorage, "registry.json"); }
    static get archivesDir() { return path.join(CONFIG.rootStorage, "archives"); }

    static async init() {
        await fs.mkdir(CONFIG.rootStorage, { recursive: true });
        await fs.mkdir(this.globalDir, { recursive: true });
        await fs.mkdir(this.projectsRoot, { recursive: true });
        await fs.mkdir(this.archivesDir, { recursive: true });

        // Self-healing initialization for critical files
        await this.loadJsonSafe(this.registryFile, { projects: {} });
        await this.loadJsonSafe(this.globalDiscussion, []);

        if (!await this.exists(this.globalBlueprint)) {
            await fs.writeFile(this.globalBlueprint, "# Global Coordination Blueprint\n\nShared meeting space.");
        }
    }

    /**
     * Proactively reads and validates JSON. 
     * If file is missing, empty, or corrupted (encoding/syntax), 
     * it REPAIRS the file with default content.
     */
    private static async loadJsonSafe<T>(filePath: string, defaultValue: T): Promise<T> {
        try {
            if (!await this.exists(filePath)) {
                await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
                return defaultValue;
            }
            const content = await fs.readFile(filePath, "utf-8");
            const cleanContent = content.replace(/^\uFEFF/, '').trim();
            if (!cleanContent) throw new Error("Empty file");
            return JSON.parse(cleanContent);
        } catch (e) {
            console.warn(`[Nexus Storage] Repairing corrupted file: ${filePath}. Error: ${(e as Error).message}`);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
            return defaultValue;
        }
    }

    static async exists(p: string) {
        try { await fs.access(p); return true; } catch { return false; }
    }

    // --- Asset & Registry Management ---
    static async getProjectManifest(id: string): Promise<ProjectManifest | null> {
        if (!id) return null;
        const p = path.join(this.projectsRoot, id, "manifest.json");
        if (!await this.exists(p)) return null;
        return JSON.parse(await fs.readFile(p, "utf-8"));
    }

    /**
     * Save a project manifest and update the global registry.
     * Uses mutex lock to prevent concurrent registry write conflicts.
     */
    static async saveProjectManifest(manifest: ProjectManifest) {
        const id = manifest.id;
        if (!id) throw new Error("Manifest ID is missing.");

        const projectDir = path.join(this.projectsRoot, id);
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, "manifest.json"), JSON.stringify(manifest, null, 2));

        // Update global registry with lock
        await this.registryLock.withLock(async () => {
            const registry = await this.listRegistry();
            registry.projects[id] = {
                name: manifest.name,
                summary: manifest.description,
                lastActive: new Date().toISOString()
            };
            await fs.writeFile(this.registryFile, JSON.stringify(registry, null, 2));
        });
    }

    static async saveAsset(id: string, fileName: string, content: string | Buffer) {
        if (!id || !fileName) throw new Error("ID or FileName is missing for asset storage.");
        const assetDir = path.join(this.projectsRoot, id, "assets");
        await fs.mkdir(assetDir, { recursive: true });
        await fs.writeFile(path.join(assetDir, fileName), content);
        return path.join("projects", id, "assets", fileName);
    }

    static async calculateTopology() {
        const registry = await this.listRegistry();
        const projectIds = Object.keys(registry.projects);
        const nodes: Array<{ id: string; name: string; type: string }> = [];
        const edges: Array<{ from: string; to: string; type: string }> = [];

        for (const id of projectIds) {
            const manifest = await this.getProjectManifest(id);
            if (!manifest) continue;
            nodes.push({ id, name: manifest.name, type: "project" });
            (manifest.relations || []).forEach(rel => {
                edges.push({ from: id, to: rel.targetId, type: rel.type });
            });
        }
        return { nodes, edges };
    }

    // --- Discussion & Log Management ---
    /**
     * Add a message to the global discussion log.
     * Uses mutex lock to prevent concurrent write conflicts.
     */
    static async addGlobalLog(from: string, text: string, category?: DiscussionMessage["category"]) {
        await this.discussionLock.withLock(async () => {
            const logs = await this.loadJsonSafe<DiscussionMessage[]>(this.globalDiscussion, []);
            logs.push({
                timestamp: new Date().toISOString(),
                from,
                text,
                category
            });
            await fs.writeFile(this.globalDiscussion, JSON.stringify(logs, null, 2));
        });
    }

    static async getRecentLogs(count: number = 10): Promise<DiscussionMessage[]> {
        const logs = await this.loadJsonSafe<DiscussionMessage[]>(this.globalDiscussion, []);
        return logs.slice(-count);
    }

    static async getProjectDocs(id: string) {
        if (!id) return null;
        const p = path.join(this.projectsRoot, id, "internal_blueprint.md");
        return (await this.exists(p)) ? await fs.readFile(p, "utf-8") : null;
    }

    static async saveProjectDocs(id: string, content: string) {
        if (!id) throw new Error("Project ID is missing for documentation storage.");
        const projectDir = path.join(this.projectsRoot, id);
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, "internal_blueprint.md"), content);
    }

    static async listRegistry(): Promise<Registry> {
        return this.loadJsonSafe<Registry>(this.registryFile, { projects: {} });
    }

    /**
     * Prune global logs, keeping only messages after the specified count.
     * Uses mutex lock to prevent concurrent write conflicts.
     */
    static async pruneGlobalLogs(count: number) {
        await this.discussionLock.withLock(async () => {
            const logs = await this.loadJsonSafe<DiscussionMessage[]>(this.globalDiscussion, []);
            await fs.writeFile(this.globalDiscussion, JSON.stringify(logs.slice(count), null, 2));
        });
    }

    /**
     * Clear all global logs.
     * Uses mutex lock to prevent concurrent write conflicts.
     */
    static async clearGlobalLogs() {
        await this.discussionLock.withLock(async () => {
            await fs.writeFile(this.globalDiscussion, "[]");
        });
    }

    // --- Global Document Management ---
    static get globalDocsDir() { return path.join(this.globalDir, "docs"); }
    static get globalDocIndexFile() { return path.join(this.globalDir, "docs_index.json"); }

    static async initGlobalDocs() {
        await fs.mkdir(this.globalDocsDir, { recursive: true });
        await this.loadJsonSafe(this.globalDocIndexFile, {});
    }

    static async listGlobalDocs(): Promise<import("../types.js").GlobalDocIndex> {
        await this.initGlobalDocs();
        return this.loadJsonSafe(this.globalDocIndexFile, {});
    }

    static async saveGlobalDoc(docId: string, title: string, content: string, updatedBy: string): Promise<void> {
        if (!docId) throw new Error("Document ID is required.");
        // Validate docId format (no slashes, no ..)
        if (docId.includes("/") || docId.includes("\\") || docId.includes("..")) {
            throw new Error("Document ID cannot contain '/', '\\' or '..'.");
        }
        await this.initGlobalDocs();

        // Save document file
        const docPath = path.join(this.globalDocsDir, `${docId}.md`);
        await fs.writeFile(docPath, content, "utf-8");

        // Update index
        const index = await this.listGlobalDocs();
        index[docId] = {
            title,
            lastUpdated: new Date().toISOString(),
            updatedBy
        };
        await fs.writeFile(this.globalDocIndexFile, JSON.stringify(index, null, 2), "utf-8");
    }

    static async getGlobalDoc(docId: string): Promise<string | null> {
        if (!docId) return null;
        const docPath = path.join(this.globalDocsDir, `${docId}.md`);
        return (await this.exists(docPath)) ? await fs.readFile(docPath, "utf-8") : null;
    }

    static async deleteGlobalDoc(docId: string): Promise<boolean> {
        if (!docId) return false;
        const docPath = path.join(this.globalDocsDir, `${docId}.md`);
        if (!await this.exists(docPath)) return false;

        await fs.unlink(docPath);

        // Update index
        const index = await this.listGlobalDocs();
        delete index[docId];
        await fs.writeFile(this.globalDocIndexFile, JSON.stringify(index, null, 2), "utf-8");
        return true;
    }

    /**
     * Patch (partial update) a project manifest.
     * Only updates fields present in the patch object.
     */
    static async patchProjectManifest(id: string, patch: Partial<ProjectManifest>): Promise<ProjectManifest> {
        const existing = await this.getProjectManifest(id);
        if (!existing) throw new Error(`Project '${id}' does not exist.`);

        // Merge patch into existing (shallow merge for top-level fields)
        const updated: ProjectManifest = { ...existing, ...patch, id }; // ID cannot be changed via patch
        updated.lastUpdated = new Date().toISOString();

        await this.saveProjectManifest(updated);
        return updated;
    }

    /**
     * Rename a project ID with cascading updates to all relations.
     * @returns Number of other projects updated with new reference.
     */
    static async renameProject(oldId: string, newId: string): Promise<number> {
        if (!oldId || !newId) throw new Error("Both oldId and newId are required.");
        if (oldId === newId) throw new Error("Old and new IDs are identical.");

        const oldDir = path.join(this.projectsRoot, oldId);
        const newDir = path.join(this.projectsRoot, newId);

        if (!await this.exists(oldDir)) throw new Error(`Project '${oldId}' does not exist.`);
        if (await this.exists(newDir)) throw new Error(`Project '${newId}' already exists.`);

        // 1. Rename directory
        await fs.rename(oldDir, newDir);

        // 2. Update manifest.id inside the project
        const manifestPath = path.join(newDir, "manifest.json");
        if (await this.exists(manifestPath)) {
            const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as ProjectManifest;
            manifest.id = newId;
            await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
        }

        // 3. Update registry with lock and cascade updates
        let updatedCount = 0;
        await this.registryLock.withLock(async () => {
            const registry = await this.listRegistry();
            if (registry.projects[oldId]) {
                registry.projects[newId] = registry.projects[oldId];
                delete registry.projects[oldId];
                await fs.writeFile(this.registryFile, JSON.stringify(registry, null, 2), "utf-8");
            }

            // 4. Cascade: Update relations in ALL other projects
            const projectIds = Object.keys(registry.projects);
            for (const id of projectIds) {
                if (id === newId) continue; // Skip the renamed project itself
                const otherManifest = await this.getProjectManifest(id);
                if (!otherManifest || !otherManifest.relations) continue;

                let changed = false;
                for (const rel of otherManifest.relations) {
                    if (rel.targetId === oldId) {
                        rel.targetId = newId;
                        changed = true;
                    }
                }
                if (changed) {
                    // Note: saveProjectManifest will try to acquire registryLock again,
                    // but since we're already holding it, we write directly here
                    const projectDir = path.join(this.projectsRoot, id);
                    await fs.writeFile(path.join(projectDir, "manifest.json"), JSON.stringify(otherManifest, null, 2));
                    updatedCount++;
                }
            }
        });

        return updatedCount;
    }

    /**
     * Delete a project from the registry and disk.
     * Uses mutex lock to prevent concurrent registry write conflicts.
     */
    static async deleteProject(id: string): Promise<void> {
        await this.registryLock.withLock(async () => {
            const registry = await this.listRegistry();
            if (registry.projects[id]) {
                delete registry.projects[id];
                await fs.writeFile(this.registryFile, JSON.stringify(registry, null, 2), "utf-8");
            }
        });

        const projectDir = path.join(this.projectsRoot, id);
        if (await this.exists(projectDir)) {
            await fs.rm(projectDir, { recursive: true, force: true });
        }
    }
}

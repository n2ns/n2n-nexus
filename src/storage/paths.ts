import path from "node:path";
import { getRootPath } from "../config/paths.js";

export class NexusPaths {
    static get root() { return getRootPath(); }
    static get globalDir() { return path.join(this.root, "global"); }
    static get globalBlueprint() { return path.join(this.globalDir, "blueprint.md"); }
    static get globalDiscussion() { return path.join(this.globalDir, "discussion.json"); }
    static get projectsRoot() { return path.join(this.root, "projects"); }
    static get registryFile() { return path.join(this.root, "registry.json"); }
    static get archivesDir() { return path.join(this.root, "archives"); }
    private static assertSafeSegment(value: string, label: string): string {
        if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === "." || value === "..") {
            throw new Error(`Invalid ${label}: '${value}'. Use only letters, numbers, dots, underscores, and hyphens.`);
        }
        return value;
    }

    static projectDir(id: string) { return path.join(this.projectsRoot, this.assertSafeSegment(id, "project id")); }
    static projectDocPath(id: string) { return path.join(this.projectDir(id), "internal_blueprint.md"); }
    static projectManifestPath(id: string) { return path.join(this.projectDir(id), "manifest.json"); }
    static projectAssetsDir(id: string) { return path.join(this.projectDir(id), "assets"); }
    static get dbFile() { return path.join(this.root, "nexus.db"); }
    static taskFile() { return path.join(this.root, "tasks.json"); }
    static docsDir() { return path.join(this.globalDir, "docs"); }
    static get docsIndexFile() { return path.join(this.globalDir, "docs_index.json"); }
    static docFile(docId: string) { return path.join(this.docsDir(), `${this.assertSafeSegment(docId, "document id")}.md`); }
}

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
    static projectDir(id: string) { return path.join(this.projectsRoot, id); }
    static projectDocPath(id: string) { return path.join(this.projectDir(id), "internal_blueprint.md"); }
    static projectManifestPath(id: string) { return path.join(this.projectDir(id), "manifest.json"); }
    static projectAssetsDir(id: string) { return path.join(this.projectDir(id), "assets"); }
    static get dbFile() { return path.join(this.root, "nexus.db"); }
    static taskFile() { return path.join(this.root, "tasks.json"); }
    static docsDir() { return path.join(this.globalDir, "docs"); }
    static get docsIndexFile() { return path.join(this.globalDir, "docs_index.json"); }
}

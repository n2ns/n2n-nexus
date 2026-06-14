import { promises as fs } from "node:fs";
import path from "node:path";
import { NexusPaths } from "./paths.js";
import { FILE_ENCODING } from "../constants.js";

export class ProjectStorage {
    private static projectFilePath(projectId: string) {
        return {
            docsPath: NexusPaths.projectDocPath(projectId),
            assetsDir: NexusPaths.projectAssetsDir(projectId),
            manifestPath: NexusPaths.projectManifestPath(projectId),
            projectDir: NexusPaths.projectDir(projectId)
        };
    }

    static async getProjectDocs(projectId: string): Promise<string> {
        const paths = this.projectFilePath(projectId);
        try {
            return await fs.readFile(paths.docsPath, FILE_ENCODING);
        } catch {
            return "";
        }
    }

    static async saveProjectDocs(projectId: string, content: string): Promise<void> {
        const paths = this.projectFilePath(projectId);
        await fs.mkdir(paths.projectDir, { recursive: true });
        await fs.writeFile(paths.docsPath, content, FILE_ENCODING);
    }

    static async saveAsset(projectId: string, fileName: string, content: string | Buffer): Promise<string> {
        const safeName = this.sanitizeFileName(fileName);
        const paths = this.projectFilePath(projectId);
        await fs.mkdir(paths.assetsDir, { recursive: true });
        const assetPath = path.join(paths.assetsDir, safeName);
        await fs.writeFile(assetPath, content, FILE_ENCODING);
        return path.relative(NexusPaths.root, assetPath);
    }

    static async deleteProject(projectId: string): Promise<number> {
        const paths = this.projectFilePath(projectId);
        try {
            await fs.rm(paths.projectDir, { recursive: true, force: true });
            return 1;
        } catch {
            return 0;
        }
    }

    static async renameProject(oldId: string, newId: string): Promise<number> {
        if (!oldId || !newId || oldId === newId) return 0;
        const oldPath = this.projectFilePath(oldId);
        const newPath = this.projectFilePath(newId);

        try {
            await fs.access(oldPath.projectDir);
        } catch {
            return 0;
        }

        await fs.mkdir(path.dirname(newPath.projectDir), { recursive: true });
        await fs.rename(oldPath.projectDir, newPath.projectDir);

        try {
            const manifestRaw = await fs.readFile(newPath.manifestPath, FILE_ENCODING);
            const manifest = JSON.parse(manifestRaw) as { id: string };
            manifest.id = newId;
            await fs.writeFile(newPath.manifestPath, JSON.stringify(manifest, null, 2), FILE_ENCODING);
        } catch {
            // Manifest is optional for some flows.
        }

        return 1;
    }

    private static sanitizeFileName(fileName: string): string {
        return fileName
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\.\./g, "_");
    }
}

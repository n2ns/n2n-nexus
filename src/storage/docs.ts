import { promises as fs } from "node:fs";
import path from "node:path";
import { NexusPaths } from "./paths.js";
import { FILE_ENCODING } from "../constants.js";
import { GlobalDocIndex } from "../types.js";

export class DocStorage {
    private static async ensureDirectory(): Promise<void> {
        await fs.mkdir(NexusPaths.docsDir(), { recursive: true });
        try {
            await fs.access(NexusPaths.docsIndexFile);
        } catch {
            await fs.writeFile(NexusPaths.docsIndexFile, JSON.stringify({}, null, 2), FILE_ENCODING);
        }
    }

    private static async readIndex(): Promise<GlobalDocIndex> {
        await this.ensureDirectory();
        try {
            const raw = await fs.readFile(NexusPaths.docsIndexFile, FILE_ENCODING);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return parsed as GlobalDocIndex;
        } catch {
            // fall through
        }
        return {};
    }

    private static async writeIndex(index: GlobalDocIndex): Promise<void> {
        await this.ensureDirectory();
        await fs.writeFile(NexusPaths.docsIndexFile, JSON.stringify(index, null, 2), FILE_ENCODING);
    }

    static async init(): Promise<void> {
        await this.ensureDirectory();
        try {
            await fs.access(NexusPaths.globalBlueprint);
        } catch {
            await fs.writeFile(
                NexusPaths.globalBlueprint,
                "# Global Collaboration Blueprint\n\nShared meeting space.",
                FILE_ENCODING
            );
        }
    }

    static async listDocs(): Promise<GlobalDocIndex> {
        await this.ensureDirectory();
        return this.readIndex();
    }

    static async getDoc(docId: string): Promise<string> {
        await this.ensureDirectory();
        const filePath = path.join(NexusPaths.docsDir(), `${docId}.md`);
        try {
            return await fs.readFile(filePath, FILE_ENCODING);
        } catch {
            return "";
        }
    }

    static async saveDoc(docId: string, title: string, content: string, updatedBy: string): Promise<void> {
        await this.ensureDirectory();
        const index = await this.readIndex();
        const filePath = path.join(NexusPaths.docsDir(), `${docId}.md`);
        await fs.writeFile(filePath, content, FILE_ENCODING);
        index[docId] = {
            title,
            lastUpdated: new Date().toISOString(),
            updatedBy
        };
        await this.writeIndex(index);
    }

    static async deleteDoc(docId: string): Promise<void> {
        await this.ensureDirectory();
        const index = await this.readIndex();
        const filePath = path.join(NexusPaths.docsDir(), `${docId}.md`);
        delete index[docId];
        await this.writeIndex(index);
        await fs.rm(filePath, { force: true });
    }
}

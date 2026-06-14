import { promises as fs } from "node:fs";
import { NexusPaths } from "./paths.js";
import { DiscussionMessage } from "../types.js";

interface LogFileEntry {
    timestamp: string;
    from: string;
    text: string;
    category?: DiscussionMessage["category"];
}

export class LogStorage {
    private static async ensureLogFile(): Promise<void> {
        try {
            await fs.access(NexusPaths.globalDiscussion);
        } catch {
            await fs.writeFile(NexusPaths.globalDiscussion, "[]", "utf-8");
        }
    }

    static async addLog(from: string, text: string, category?: string): Promise<void> {
        await this.ensureLogFile();
        const logs = await this.getLogs();
        const payload: LogFileEntry = {
            timestamp: new Date().toISOString(),
            from,
            text,
            category: this.normalizeCategory(category)
        };
        logs.push(payload);
        await fs.writeFile(NexusPaths.globalDiscussion, JSON.stringify(logs, null, 2), "utf-8");
    }

    private static normalizeCategory(category?: string): DiscussionMessage["category"] | undefined {
        if (!category) return undefined;
        const allowed: DiscussionMessage["category"][] = ["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT", "message", "SYSTEM"];
        return allowed.includes(category as DiscussionMessage["category"]) ? category as DiscussionMessage["category"] : "UPDATE";
    }

    static async getLogs(limit: number = 10): Promise<DiscussionMessage[]> {
        await this.ensureLogFile();
        const rows = await this.readRawLogs();
        if (limit <= 0) return rows;
        return rows.slice(-limit);
    }

    static async pruneLogs(count: number): Promise<void> {
        const current = await this.readRawLogs();
        if (count <= 0) return;
        if (current.length <= count) return;
        const remaining = current.slice(count);
        await fs.writeFile(NexusPaths.globalDiscussion, JSON.stringify(remaining, null, 2), "utf-8");
    }

    static async clearLogs(): Promise<void> {
        await fs.writeFile(NexusPaths.globalDiscussion, "[]", "utf-8");
    }

    private static async readRawLogs(): Promise<DiscussionMessage[]> {
        await this.ensureLogFile();
        try {
            const raw = await fs.readFile(NexusPaths.globalDiscussion, "utf-8");
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed as DiscussionMessage[] : [];
        } catch {
            return [];
        }
    }
}

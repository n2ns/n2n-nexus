import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { promises as fs } from "fs";
import path from "path";

import { createDaemonServer } from "../src/daemon/server.js";
import { closeDatabase } from "../src/storage/sqlite.js";
import { StorageManager } from "../src/storage/index.js";
import { UnifiedMeetingStore } from "../src/storage/store.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "daemon-messages");
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

describe("Daemon messages API", () => {
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

    it("supports unread cursor per instance for meeting messages", async () => {
        const storageInfo = await UnifiedMeetingStore.getStorageInfo();
        if (storageInfo.storage_mode === "json") {
            return;
        }

        const meeting = await UnifiedMeetingStore.startMeeting("Daemon Cursor", "IDE-A");

        const firstSend = await requestJson<{ ok: boolean; sentTo: "meeting" | "global"; meetingId?: string }>(
            daemon!.port.toString(),
            "POST",
            "/api/messages/send",
            {
                message: "first",
                source: "meeting",
                meetingId: meeting.id,
                instanceId: "IDE-B"
            }
        );
        expect(firstSend.status).toBe(200);
        expect(firstSend.payload.ok).toBe(true);
        expect(firstSend.payload.meetingId).toBe(meeting.id);

        const firstRead = await requestJson<{ source: string; meetingId?: string; messages: Array<{ text: string }>; count: number }>(
            daemon!.port.toString(),
            "GET",
            `/api/messages/unread?meetingId=${encodeURIComponent(meeting.id)}&instanceId=IDE-B&count=10`
        );
        expect(firstRead.status).toBe(200);
        expect(firstRead.payload.source).toBe("meeting");
        expect(firstRead.payload.messages).toHaveLength(1);
        expect(firstRead.payload.messages[0].text).toBe("first");

        const secondSend = await requestJson<{ ok: boolean; sentTo: "meeting" | "global"; meetingId?: string }>(
            daemon!.port.toString(),
            "POST",
            "/api/messages/send",
            {
                message: "second",
                source: "meeting",
                meetingId: meeting.id,
                instanceId: "IDE-C"
            }
        );
        expect(secondSend.status).toBe(200);
        expect(secondSend.payload.ok).toBe(true);

        const secondRead = await requestJson<{ source: string; meetingId?: string; messages: Array<{ text: string }>; count: number }>(
            daemon!.port.toString(),
            "GET",
            `/api/messages/unread?meetingId=${encodeURIComponent(meeting.id)}&instanceId=IDE-B&count=10`
        );
        expect(secondRead.status).toBe(200);
        expect(secondRead.payload.messages).toHaveLength(1);
        expect(secondRead.payload.messages[0].text).toBe("second");

        const thirdRead = await requestJson<{ source: string; meetingId?: string; messages: Array<{ text: string }>; count: number }>(
            daemon!.port.toString(),
            "GET",
            `/api/messages/unread?meetingId=${encodeURIComponent(meeting.id)}&instanceId=IDE-B&count=10`
        );
        expect(thirdRead.status).toBe(200);
        expect(thirdRead.payload.messages).toHaveLength(0);
    });
});

import http from "http";
import { NEXUS_HOST } from "../constants.js";

// Basic SSE Parser state
// In a production env, use 'eventsource-parser'
type SSEState = {
    buffer: string;
};

export class GuestClient {
    private targetPort: number;
    private guestId: string;
    private sessionId: string | null = null;
    private requestQueue: { method: string; params: unknown; resolve: (val: unknown) => void; reject: (err: unknown) => void }[] = [];
    private pendingRequests = new Map<string | number, { resolve: (val: unknown) => void; reject: (err: unknown) => void }>();
    private isConnected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private sseRequest: http.ClientRequest | null = null;
    private onReElectionNeeded: (() => void) | null = null;
    private connectionFailures = 0;

    constructor(targetPort: number, guestId: string, onReElectionNeeded?: () => void) {
        this.targetPort = targetPort;
        this.guestId = guestId;
        this.onReElectionNeeded = onReElectionNeeded || null;
        this.start();
    }

    /**
     * Public API to send a request (buffered if not connected)
     */
    public async sendRequest(method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (this.sessionId) {
                this.doPost(method, params, resolve, reject);
            } else {
                this.requestQueue.push({ method, params, resolve, reject });
            }
        });
    }

    /**
     * Terminate the client (useful for testing/shutdown)
     */
    public close() {
        this.isConnected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.pendingRequests.forEach(p => p.reject(new Error("GuestClient closed")));
        this.pendingRequests.clear();

        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }
    }

    private start() {
        console.error(`[Nexus:${this.guestId}] Connecting to Host at ${this.targetPort}...`);

        // Connect SSE
        const connectHost = NEXUS_HOST === "0.0.0.0" ? "127.0.0.1" : NEXUS_HOST;
        const options = {
            hostname: connectHost,
            port: this.targetPort,
            path: `/mcp?id=${encodeURIComponent(this.guestId)}`,
            method: "GET",
            headers: {
                "Accept": "text/event-stream",
                "Connection": "keep-alive"
            }
        };

        const req = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                console.error(`[Nexus Guest] Handshake failed: ${res.statusCode}`);
                this.scheduleReconnect(true); // Treat as failure
                return;
            }

            this.isConnected = true;
            this.connectionFailures = 0; // Reset counter

            // Setup robust stream reading
            const state: SSEState = { buffer: "" };

            res.on("data", (chunk) => this.handleSSEChunk(chunk.toString(), state));
            res.on("end", () => {
                console.error("[Nexus Guest] Connection closed (end) by Host.");
                this.isConnected = false;
                this.scheduleReconnect(true);
            });
            res.on("close", () => {
                if (this.isConnected) {
                    console.error("[Nexus Guest] Connection closed (close) by Host.");
                    this.isConnected = false;
                    this.scheduleReconnect(true);
                }
            });
        });

        req.on("close", () => {
            if (this.isConnected) {
                console.error("[Nexus Guest] Request closed.");
                this.isConnected = false;
                this.scheduleReconnect(true);
            }
        });

        req.on("error", (err) => {
            const code = (err as { code?: string }).code;
            console.error(`[Nexus Guest] Connect error: ${err.message} (Code: ${code})`);
            this.isConnected = false;
            // Check for connection refusal (Host down) or Reset
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
                this.scheduleReconnect(true);
            } else {
                this.scheduleReconnect(false); // Maybe temporary network blip
            }
        });

        req.end();
        this.sseRequest = req;
    }

    private handleSSEChunk(chunk: string, state: SSEState) {
        state.buffer += chunk;

        const lines = state.buffer.split("\n");
        // Keep the last partial line in buffer
        state.buffer = lines.pop() || "";

        let eventType = "message";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                // Empty line = Event dispatch
                eventType = "message"; // reset
                continue;
            }

            if (trimmed.startsWith("event: ")) {
                eventType = trimmed.substring(7).trim();
            } else if (trimmed.startsWith("data: ")) {
                const data = trimmed.substring(6);
                this.processEvent(eventType, data);
            }
        }
    }

    private processEvent(type: string, data: string) {
        if (type === "endpoint") {
            const match = data.match(/sessionId=([a-f0-9-]+)/);
            if (match) {
                this.sessionId = match[1];
                this.flushQueue();
            }
        } else if (type === "message") {
            try {
                const msg = JSON.parse(data);

                // 1. Handle Responses to our Requests
                if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                    const { resolve, reject } = this.pendingRequests.get(msg.id)!;
                    this.pendingRequests.delete(msg.id);

                    if (msg.error) {
                        reject(msg.error);
                    } else {
                        resolve(msg.result);
                    }
                    return;
                }

                // 2. Handle Notifications (log to stdout)
                // If it's a notification (no id) or we aren't tracking it
                if (!msg.id) {
                    process.stdout.write(JSON.stringify(msg) + "\n");
                }
            } catch {
                // Fallback for non-JSON messages?
                // process.stdout.write(data + "\n");
            }
        }
    }

    private async doPost(method: string, params: unknown, resolve: (val: unknown) => void, reject: (err: unknown) => void) {
        if (!this.sessionId) return;

        const id = Math.floor(Math.random() * 1000000); // Req ID
        const payload = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };

        // Track request
        this.pendingRequests.set(id, { resolve, reject });

        const postData = JSON.stringify(payload);
        const connectHost = NEXUS_HOST === "0.0.0.0" ? "127.0.0.1" : NEXUS_HOST;

        const req = http.request({
            hostname: connectHost,
            port: this.targetPort,
            path: `/mcp?sessionId=${this.sessionId}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    // 202 Accepted -> Expect response via SSE later
                    if (res.statusCode === 202) {
                        return;
                    }

                    if (res.statusCode !== 200) {
                        this.pendingRequests.delete(id);
                        reject(new Error(`Host returned ${res.statusCode}: ${data}`));
                        return;
                    }

                    // 200 OK -> Response might be in body
                    if (data) {
                        const json = JSON.parse(data);
                        if (json.id !== undefined && this.pendingRequests.has(json.id)) {
                            // Resolved immediately
                            this.pendingRequests.delete(json.id);
                            if (json.error) {
                                reject(json.error);
                            } else {
                                resolve(json.result);
                            }
                        }
                    }
                } catch (e) {
                    this.pendingRequests.delete(id);
                    reject(e);
                }
            });
        });

        req.on("error", (e) => {
            this.pendingRequests.delete(id);
            reject(e);
        });
        req.write(postData);
        req.end();
    }

    private flushQueue() {
        console.error(`[Nexus Guest] Session established (${this.sessionId}). Flushing ${this.requestQueue.length} requests...`);
        while (this.requestQueue.length > 0) {
            const req = this.requestQueue.shift();
            if (req) this.doPost(req.method, req.params, req.resolve, req.reject);
        }
    }

    private scheduleReconnect(isHardFailure: boolean = false) {
        if (this.reconnectTimer) return;
        this.sessionId = null;

        if (isHardFailure) {
            this.connectionFailures++;
        }

        // If Host is offline, initiate Re-Election almost immediately if callback provided.
        // We use a small threshold > 0 to avoid blips, but for test speed, 1 is fine if it's ECONNREFUSED.
        if (this.onReElectionNeeded && isHardFailure) {
            console.error(`[Nexus Guest] Connection lost/refused. Triggering Re-Election.`);
            this.onReElectionNeeded();
            return;
        }

        const delay = this.connectionFailures > 5 ? 5000 : 1000;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            this.start();
        }, delay);
    }
}

// Factory function to maintain compatibility with index.ts
export function createGuestClient(port: number, id: string, onReElectionNeeded?: () => void) {
    return new GuestClient(port, id, onReElectionNeeded);
}

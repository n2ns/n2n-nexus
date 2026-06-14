import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
};

export type NexusClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

function normalizeEndpoint(endpoint?: string): string {
    const raw = endpoint || process.env.NEXUS_ENDPOINT || "http://127.0.0.1:5688";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
}

export class NexusClient {
    private endpoint: string;
    private timeoutMs: number;

    constructor(options: NexusClientOptions = {}) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.timeoutMs = options.timeoutMs ?? 5000;
    }

    private request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = new URL(path, this.endpoint);
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const transport = url.protocol === "https:" ? https : http;

        return new Promise((resolve, reject) => {
            const req = transport.request(
                {
                    method,
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: `${url.pathname}${url.search}`,
                    headers: {
                        "Content-Type": "application/json",
                        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
                    },
                    timeout: this.timeoutMs
                },
                (res) => {
                    let data = "";
                    res.on("data", chunk => { data += chunk; });
                    res.on("end", () => {
                        try {
                            const parsed = data ? JSON.parse(data) : {};
                            if (res.statusCode && res.statusCode >= 400) {
                                reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                            } else {
                                resolve(parsed as T);
                            }
                        } catch {
                            reject(new Error(`Invalid JSON response: ${data}`));
                        }
                    });
                }
            );

            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Request timeout")));
            if (payload) req.write(payload);
            req.end();
        });
    }

    async health(): Promise<{ ok: boolean; version: string }> {
        return this.request("GET", "/health");
    }

    async fetchTools(): Promise<ToolDefinition[]> {
        const res = await this.request<{ tools: ToolDefinition[] }>("GET", "/api/tools");
        return res.tools;
    }

    async callTool(name: string, args: unknown, instanceId?: string): Promise<unknown> {
        const res = await this.request<{ ok: boolean; result: unknown; error?: string }>(
            "POST", "/api/tools/call",
            { tool: name, args: args || {}, instanceId: instanceId || "unknown" }
        );
        if (!res.ok) throw new Error(res.error || "Tool call failed");
        return res.result;
    }
}

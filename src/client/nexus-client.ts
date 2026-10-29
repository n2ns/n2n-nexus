import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import type { Caller, HookRequest, HookResponse } from "../contract.js";
import { configuredEndpoint } from "./discovery.js";

type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
    annotations?: Record<string, unknown>;
};

type NexusClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

/** The daemon could not be reached or answered with something that is not JSON. */
export class NexusTransportError extends Error {
    /** System error code when the connection itself failed, e.g. "ECONNREFUSED". */
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "NexusTransportError";
    }
}

/** NexusTransportError code when the daemon did not answer within the request timeout. */
export const REQUEST_TIMEOUT_CODE = "EREQUESTTIMEOUT";

/** The daemon answered, but the tool call itself failed (unknown tool, validation, not found, ...). */
export class NexusToolError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = "NexusToolError";
    }
}

function normalizeEndpoint(endpoint?: string): string {
    const raw = configuredEndpoint(endpoint);
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

    private request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
        const url = new URL(path, this.endpoint);
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const transport = url.protocol === "https:" ? https : http;

        return new Promise((resolve, reject) => {
            const req = transport.request(
                url,
                {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
                    },
                    timeout: timeoutMs
                },
                (res) => {
                    let data = "";
                    res.setEncoding("utf8");
                    const interrupted = () => reject(new NexusTransportError("Response from n2n-nexus-host ended before completion", "ECONNRESET"));
                    res.on("aborted", interrupted);
                    res.on("error", (error) => reject(new NexusTransportError(error.message)));
                    res.on("close", () => { if (!res.complete) interrupted(); });
                    res.on("data", chunk => { data += chunk; });
                    res.on("end", () => {
                        let parsed: { error?: string };
                        try {
                            parsed = data ? JSON.parse(data) : {};
                        } catch {
                            reject(new NexusTransportError(`Invalid JSON response from n2n-nexus-host: ${data.slice(0, 200)}`));
                            return;
                        }
                        const status = res.statusCode ?? 0;
                        if (status >= 400) {
                            reject(new NexusToolError(parsed.error || `HTTP ${status}`, status));
                        } else {
                            resolve(parsed as T);
                        }
                    });
                }
            );

            req.on("error", (e: NodeJS.ErrnoException) => reject(e instanceof NexusTransportError ? e : new NexusTransportError(e.message, e.code)));
            req.on("timeout", () => req.destroy(new NexusTransportError(`Request to ${this.endpoint} timed out after ${timeoutMs} ms`, REQUEST_TIMEOUT_CODE)));
            if (payload) req.write(payload);
            req.end();
        });
    }

    /** GET /health: n2n-nexus-host answers `{ ok, service: "n2n-nexus", version, contractVersion, sessions: { online } }`. */
    async health(): Promise<{ ok?: unknown; service?: unknown; version?: unknown; contractVersion?: unknown }> {
        return this.request("GET", "/health");
    }

    async fetchTools(): Promise<ToolDefinition[]> {
        const res = await this.request<{ tools: ToolDefinition[] }>("GET", "/api/tools");
        return res.tools;
    }

    /** Forward a client hook event; `timeoutMs` overrides the client timeout (a listening Stop waits long). */
    async hook(request: HookRequest, timeoutMs?: number): Promise<HookResponse> {
        return this.request<HookResponse>("POST", "/api/hook", request, timeoutMs);
    }

    async callTool(name: string, args: unknown, instanceId?: string, caller?: Caller): Promise<unknown> {
        const res = await this.request<{ ok: boolean; result: unknown; error?: string }>(
            "POST", "/api/tools/call",
            { tool: name, args: args || {}, ...(instanceId ? { instanceId } : {}), ...(caller ? { caller } : {}) }
        );
        if (!res.ok) throw new NexusToolError(res.error || "Tool call failed", 200);
        return res.result;
    }
}

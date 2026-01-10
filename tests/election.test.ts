import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";

// Port range for testing (use higher ports to avoid conflicts)
const TEST_PORT_START = 15688;
const TEST_PORT_END = 15700;

/**
 * Helper: Create a mock Nexus Host server
 */
function createMockHost(port: number, rootStorage: string): Promise<http.Server> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (req.method === "POST" && req.url === "/nexus/handshake") {
                let body = "";
                req.on("data", chunk => body += chunk);
                req.on("end", () => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        service: "n2n-nexus",
                        protocol: "v1",
                        role: "host",
                        serverVersion: "0.2.1",
                        rootStorage,
                        status: "ready"
                    }));
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

/**
 * Helper: Probe a port for Nexus Host (mirrors config.ts logic)
 */
async function probeHost(port: number): Promise<{ isNexus: boolean; rootStorage?: string }> {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            clientVersion: "test-client",
            instanceId: "test-id"
        });

        const req = http.request({
            hostname: "127.0.0.1",
            port: port,
            path: "/nexus/handshake",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 500
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    if (info.service === "n2n-nexus" && info.role === "host") {
                        resolve({ isNexus: true, rootStorage: info.rootStorage });
                    } else {
                        resolve({ isNexus: false });
                    }
                } catch {
                    resolve({ isNexus: false });
                }
            });
        });

        req.on("error", () => resolve({ isNexus: false }));
        req.on("timeout", () => {
            req.destroy();
            resolve({ isNexus: false });
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Helper: Try to bind a port (mirrors Phase 2 of election)
 */
async function tryBind(port: number): Promise<{ success: boolean; server?: http.Server }> {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.on("error", (err: any) => {
            if (err.code === "EADDRINUSE") {
                resolve({ success: false });
            } else {
                resolve({ success: false });
            }
        });
        server.listen(port, "127.0.0.1", () => {
            resolve({ success: true, server });
        });
    });
}

describe("Host Election Algorithm", () => {
    let servers: http.Server[] = [];

    afterEach(async () => {
        // Clean up all test servers
        for (const server of servers) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        servers = [];
    });

    describe("probeHost", () => {
        it("should detect a Nexus Host and return rootStorage", async () => {
            const mockServer = await createMockHost(TEST_PORT_START, "/test/storage");
            servers.push(mockServer);

            const result = await probeHost(TEST_PORT_START);
            expect(result.isNexus).toBe(true);
            expect(result.rootStorage).toBe("/test/storage");
        });

        it("should return isNexus=false for empty port", async () => {
            const result = await probeHost(TEST_PORT_START + 1);
            expect(result.isNexus).toBe(false);
        });

        it("should return isNexus=false for non-Nexus HTTP server", async () => {
            const fakeServer = http.createServer((req, res) => {
                res.writeHead(200);
                res.end("Hello World");
            });
            await new Promise<void>(r => fakeServer.listen(TEST_PORT_START + 2, "127.0.0.1", () => r()));
            servers.push(fakeServer);

            const result = await probeHost(TEST_PORT_START + 2);
            expect(result.isNexus).toBe(false);
        });
    });

    describe("Port Binding (Atomic)", () => {
        it("should successfully bind an available port", async () => {
            const result = await tryBind(TEST_PORT_START + 3);
            expect(result.success).toBe(true);
            if (result.server) servers.push(result.server);
        });

        it("should fail to bind an occupied port", async () => {
            // First, occupy the port
            const first = await tryBind(TEST_PORT_START + 4);
            expect(first.success).toBe(true);
            if (first.server) servers.push(first.server);

            // Second attempt should fail
            const second = await tryBind(TEST_PORT_START + 4);
            expect(second.success).toBe(false);
        });
    });

    describe("Election Flow", () => {
        it("Phase 1: Should join existing Host if found during probe", async () => {
            // Simulate existing Host
            const existingHost = await createMockHost(TEST_PORT_START + 5, "/existing/storage");
            servers.push(existingHost);

            // Simulate election Phase 1: probe first
            const probe = await probeHost(TEST_PORT_START + 5);
            expect(probe.isNexus).toBe(true);
            expect(probe.rootStorage).toBe("/existing/storage");
            // Guest should join this Host, not try to become one
        });

        it("Phase 2: Should become Host if no existing Host found", async () => {
            // Simulate election Phase 1: probe first (no Host)
            const probe = await probeHost(TEST_PORT_START + 6);
            expect(probe.isNexus).toBe(false);

            // Proceed to Phase 2: try to become Host
            const bind = await tryBind(TEST_PORT_START + 6);
            expect(bind.success).toBe(true);
            if (bind.server) servers.push(bind.server);
        });

        it("Phase 3: Should join winner after bind failure", async () => {
            // Simulate another Guest winning the race
            const winner = await createMockHost(TEST_PORT_START + 7, "/winner/storage");
            servers.push(winner);

            // Simulate this Guest's bind failing
            const bind = await tryBind(TEST_PORT_START + 7);
            expect(bind.success).toBe(false);

            // Wait (simulating the 10s delay) then probe again
            await new Promise(r => setTimeout(r, 100)); // Shortened for test
            const probe = await probeHost(TEST_PORT_START + 7);
            expect(probe.isNexus).toBe(true);
            expect(probe.rootStorage).toBe("/winner/storage");
        });
    });

    describe("Multi-Guest Race Simulation", () => {
        it("Only one Guest should become Host when racing", async () => {
            const testPort = TEST_PORT_START + 8;

            // Simulate 5 Guests racing to bind the same port
            const results = await Promise.all([
                tryBind(testPort),
                tryBind(testPort),
                tryBind(testPort),
                tryBind(testPort),
                tryBind(testPort),
            ]);

            // Exactly one should succeed
            const winners = results.filter(r => r.success);
            const losers = results.filter(r => !r.success);

            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(4);

            // Clean up winner's server
            if (winners[0].server) servers.push(winners[0].server);
        });
    });
});

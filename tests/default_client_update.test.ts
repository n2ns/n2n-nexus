import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { npmTestEnv, REPO, runCli } from "./helpers/cli.js";

it("checks each session start without waiting for npm; off survives restarts but never suppresses manual checks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-startup-"));
    const prefix = path.join(tmp, "prefix");
    const root = path.join(prefix, process.platform === "win32" ? "" : "lib", "node_modules/n2n-nexus");
    if (process.platform !== "win32") {
        const shared = path.join(tmp, "shared-packages");
        fs.mkdirSync(shared);
        fs.mkdirSync(prefix);
        fs.symlinkSync(shared, path.join(prefix, "lib"), "dir");
    }
    fs.mkdirSync(root, { recursive: true });
    for (const file of ["build", "contract", "package.json"]) fs.cpSync(path.join(REPO, file), path.join(root, file), { recursive: true });
    const entry = path.join(root, "build/index.js");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts.postinstall).toBeUndefined();
    const healthyManifest = JSON.stringify({ name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: pkg } });
    const next = "888.0.0";
    let manifest = JSON.stringify({ name: pkg.name, "dist-tags": { latest: next }, versions: {
        [next]: { ...pkg, version: next, nexusContractVersion: pkg.nexusContractVersion + 1 }
    } });
    let requests = 0;
    let hold = true;
    let deny = false;
    const pending: http.ServerResponse[] = [];
    const registry = http.createServer((req, res) => {
        if (req.url !== "/n2n-nexus") { res.writeHead(404).end(); return; }
        requests++;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (deny) {
            res.writeHead(403).end('{"error":"private-registry-canary"}');
            return;
        }
        if (hold) pending.push(res); else res.end(manifest);
    });
    await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
    const addr = registry.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const env = { ...npmTestEnv(), HOME: tmp, USERPROFILE: tmp, LOCALAPPDATA: path.join(tmp, "local"), npm_config_prefix: prefix,
        npm_config_registry: `http://127.0.0.1:${addr.port}/`, npm_config_userconfig: path.join(tmp, ".npmrc"), npm_config_cache: path.join(tmp, "cache"), npm_config_fetch_retries: "0" };
    const id = createHash("sha256").update(fs.realpathSync(prefix)).digest("hex").slice(0, 24);
    const lock = path.join(tmp, ".local/state/n2n-nexus/client-update", id, "lock.db");
    const waitIdle = () => expect.poll(() => {
        if (!fs.existsSync(lock)) return false;
        const db = new DatabaseSync(lock);
        try { db.exec("BEGIN IMMEDIATE; ROLLBACK"); return true; } catch { return false; } finally { db.close(); }
    }, { timeout: 10_000 }).toBe(true);
    const pref = async (action: string) => {
        const r = await runCli(["auto-update", action], { entry, env });
        expect(r.code, r.stderr).toBe(0);
    };
    const event = async (name: string) => {
        const r = await runCli(["hook", "pi", "--endpoint", "http://127.0.0.1:1"], { entry, env, timeoutMs: 10_000,
            stdin: JSON.stringify({ session_id: "fixture", hook_event_name: name }) });
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout).toBe("");
    };
    try {
        // If the hook waits for npm it will time out: the registry cannot answer until it returns.
        await event("SessionStart");
        await expect.poll(() => requests, { timeout: 10_000 }).toBe(1);
        hold = false;
        for (const res of pending) res.end(manifest);
        await waitIdle();
        const diagnosis = () => runCli(["doctor", "pi"], { entry, env: { ...env, NEXUS_ENDPOINT: "http://127.0.0.1:1" } });
        expect((await diagnosis()).stdout).toContain("coordinated update");
        manifest = healthyManifest;
        hold = true;
        await event("SessionStart");
        await expect.poll(() => requests, { timeout: 10_000 }).toBe(2);
        // A competing updater cannot replace the last completed result with a lock error.
        const competing = await runCli(["auto-update", "startup"], { entry, env });
        expect(competing.code).toBe(1);
        expect((await diagnosis()).stdout).toContain("coordinated update");
        hold = false;
        pending.at(-1)!.end(manifest);
        await waitIdle();
        expect((await diagnosis()).stdout).not.toContain("coordinated update");
        await pref("off");
        await event("SessionStart");
        await pref("startup"); // even a worker already launched before off rechecks the choice
        expect(requests).toBe(2);
        await pref("run");
        expect(requests).toBe(3);
        await pref("on");
        await event("PostToolUse");
        await event("SessionStart");
        await expect.poll(() => requests, { timeout: 10_000 }).toBe(4);
        await waitIdle();
        deny = true;
        await event("SessionStart");
        await expect.poll(() => requests, { timeout: 10_000 }).toBe(5);
        await waitIdle();
        const report = (await diagnosis()).stdout;
        expect(report).toContain("npm view failed (E403)");
        expect(report).not.toContain("private-registry-canary");

        // Simulate an unreadable record independent of platform and test process permissions.
        const failureFile = path.join(path.dirname(lock), "failure.txt");
        fs.unlinkSync(failureFile);
        fs.mkdirSync(failureFile);
        const unreadable = await diagnosis();
        expect(unreadable.code).toBe(1);
        expect(unreadable.stdout).toContain("Could not read the last client update result");
        expect(unreadable.stdout).toContain("pi\n");
        expect(unreadable.stdout).toContain("host http://127.0.0.1:1");
    } finally {
        hold = false;
        registry.closeAllConnections();
        await new Promise<void>(resolve => registry.close(() => resolve()));
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
    }
}, 60_000);

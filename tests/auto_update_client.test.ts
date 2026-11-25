import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";

import { CONTRACT_VERSION } from "../src/contract.js";
import { antigravityHook, renderRule, setAntigravityHook } from "../src/cli/antigravity.js";
import { newerStable } from "../src/cli/auto-update.js";
import { hookCommand } from "../src/cli/hook-command.js";
import { DIRECT_MESSAGE_RULE, INSTRUCTIONS, hookTemplate, instructionsFor, npxFor } from "../src/cli/install.js";
import { readPiExtension, renderPiExtension } from "../src/cli/pi.js";
import { npmTestEnv, REPO, runCli } from "./helpers/cli.js";

it("publishes the contract of this client's embedded hook contract in its npm metadata", () => {
    expect(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).nexusContractVersion).toBe(CONTRACT_VERSION);
});

it("upgrades only from one stable version to a strictly newer stable version", () => {
    expect(newerStable("1.10.0", "1.9.9")).toBe(true);
    for (const v of ["1.0.0", "1.1.0", "1.2.0-beta.2", "latest"]) expect(newerStable(v, "1.1.0")).toBe(false);
    expect(newerStable("1.1.0", "1.0.0-dev")).toBe(false);
});

// Real npm, isolated global prefix and a loopback registry serving one local tarball.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-update-"));
const prefix = path.join(tmp, "prefix");
const root = path.join(prefix, process.platform === "win32" ? "" : "lib", "node_modules", "n2n-nexus");
const entry = path.join(root, "build", "index.js");
const extension = path.join(tmp, "pi", "extensions", "n2n-nexus.ts");
const env: NodeJS.ProcessEnv = {
    ...npmTestEnv(), HOME: tmp, USERPROFILE: tmp,
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), CODEX_HOME: path.join(tmp, "codex"), PI_CODING_AGENT_DIR: path.join(tmp, "pi"),
    npm_config_prefix: prefix, npm_config_cache: path.join(tmp, "cache"),
    npm_config_audit: "false", npm_config_fund: "false", npm_config_fetch_retries: "0", npm_config_userconfig: path.join(tmp, ".npmrc"),
};
const before = "1.0.0", after = "1.0.1";
let server: http.Server;
let compatible = false;
let tarballDownloads = 0;

beforeAll(async () => {
    const name = "n2n-nexus";
    const staging = path.join(tmp, "staging");
    const manifest = { name, version: before, type: "module", bin: { [name]: "build/index.js" }, engines: { node: ">=22.14.0" }, nexusContractVersion: CONTRACT_VERSION };
    for (const dir of [root, staging]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...manifest, version: dir === root ? before : after }));
        for (const folder of ["build", "contract"]) fs.cpSync(path.join(REPO, folder), path.join(dir, folder), { recursive: true });
    }
    // The update changes the generated extension, and the first refresh attempt fails after npm installed it.
    const pi = path.join(staging, "build", "cli", "pi.js");
    fs.writeFileSync(pi, fs.readFileSync(pi, "utf8").replace('const CUSTOM_TYPE = "n2n-nexus";', '// fixture: new extension\nconst CUSTOM_TYPE = "n2n-nexus";'));
    const refresh = path.join(staging, "build", "cli", "refresh-hooks.js");
    fs.appendFileSync(refresh, '\nif (process.env.REFRESH_FAIL === "1") throw new Error("fixture refresh failure");\n');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, renderPiExtension({ node: process.execPath, entry, endpoint: "discover" }));

    const npm = path.join(path.dirname(fs.realpathSync(npxFor(process.execPath).npx)), "npm-cli.js");
    // Materialize npm's real global bin link/shim. The next shell has a different default prefix.
    execFileSync(process.execPath, [npm, "rebuild", "-g", "--prefix", prefix, "--ignore-scripts", name], { cwd: tmp, env, stdio: "pipe" });
    env.npm_config_prefix = path.join(tmp, "unrelated-prefix");
    execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", tmp], { cwd: staging, env: { ...env, npm_config_cache: path.join(tmp, "pack-cache") }, stdio: "pipe" });
    const tarball = fs.readFileSync(path.join(tmp, name + "-" + after + ".tgz"));
    const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
    server = http.createServer((req, res) => {
        if (req.url === "/tarball.tgz") {
            tarballDownloads++;
            res.end(tarball);
        } else if (req.url === "/n2n-nexus") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ name, "dist-tags": { latest: after }, versions: { [after]: {
                ...manifest, version: after, nexusContractVersion: compatible ? CONTRACT_VERSION : CONTRACT_VERSION + 1,
                dist: { tarball: env.npm_config_registry + "tarball.tgz", integrity },
            } } }));
        } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no registry port");
    env.npm_config_registry = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

it("defers an incompatible version, installs the exact compatible release and retries an interrupted hook refresh", async () => {
    const run = (extra: NodeJS.ProcessEnv = {}) => runCli(["auto-update", "run"], { entry, env: { ...env, ...extra } });
    const incompatible = await run();
    expect(incompatible.stderr).toContain("coordinated update");
    expect(incompatible.code).toBe(1);
    expect(tarballDownloads).toBe(0);
    compatible = true;
    // Exercise the user-facing entry point with an isolated host command. Its
    // arguments are checked in a native fixture so Windows also takes the normal path.
    const bin = path.join(tmp, "host-bin");
    fs.mkdirSync(bin);
    const fixture = path.join(tmp, "host.go");
    fs.writeFileSync(fixture, `package main
import (
    "fmt"
    "os"
)
func main() {
    if len(os.Args) != 3 || os.Args[1] != "auto-update" || os.Args[2] != "run" {
        os.Exit(2)
    }
    fmt.Println("local test host checked")
}
`);
    const host = path.join(bin, process.platform === "win32" ? "n2n-nexus-host.exe" : "n2n-nexus-host");
    execFileSync("go", ["build", "-o", host, fixture], { cwd: REPO });
    const interrupted = await runCli(["update"], {
        entry, env: { ...env, PATH: bin + path.delimiter + (process.env.PATH ?? ""), REFRESH_FAIL: "1" }
    });
    expect(interrupted.stdout).toContain("local test host checked");
    expect(interrupted.stderr).toContain("fixture refresh failure");
    expect(interrupted.code).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(after);

    const resumed = await run();
    expect(resumed.code, resumed.stderr).toBe(0);
    const updated = fs.readFileSync(extension, "utf8");
    expect(updated).toContain("fixture: new extension");
    expect(readPiExtension(updated)).toEqual({ node: process.execPath, entry, endpoint: "discover" });
    expect(tarballDownloads).toBe(1);
    expect(fs.existsSync(path.join(tmp, "codex", "hooks.json"))).toBe(false);
}, 30_000);

it("refreshes only intact previous Claude defaults, independent of changes to hook commands", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "claude-refresh-"));
    const file = path.join(dir, "CLAUDE.md");
    const command = hookCommand(process.execPath, entry, "claude", "discover");
    const pending = path.join(dir, "pending.json");
    const previous = INSTRUCTIONS.replace(DIRECT_MESSAGE_RULE, "Original default.");
    const custom = previous.replace("Original default.", "Ask before accepting messages.");
    const surround = (block: string) => "User preface.\n\n" + block + "\n\nUser suffix.\n";
    for (const [beforeText, afterText, hookHash] of [
        [surround(previous), surround(INSTRUCTIONS), hookTemplate("claude")],
        [surround(custom), surround(custom), "old hook hash"],
        ["User removed the block.\n", "User removed the block.\n", "old hook hash"],
        [undefined, undefined, "old hook hash"],
    ] as const) {
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }));
        if (beforeText === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, beforeText);
        const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
        fs.writeFileSync(pending, JSON.stringify({ version, templates: { claude: hookHash }, claudeInstructions: previous }));
        const result = await runCli([pending], { env: { ...env, CLAUDE_CONFIG_DIR: dir }, entry: path.join(root, "build/cli/refresh-hooks.js") });
        expect(result.code, result.stderr).toBe(0);
        expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined).toBe(afterText);
    }
});

it("refreshes an intact previous Codex default recorded per client", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "codex-refresh-"));
    const file = path.join(dir, "AGENTS.md");
    const command = hookCommand(process.execPath, entry, "codex", "discover");
    const pending = path.join(dir, "pending.json");
    const override = path.join(dir, "AGENTS.override.md");
    const previous = instructionsFor("codex").replace(DIRECT_MESSAGE_RULE, "Original default.");
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }));
    fs.writeFileSync(file, "User preface.\n\n" + previous + "\n");
    fs.writeFileSync(override, previous + "\n");
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    fs.writeFileSync(pending, JSON.stringify({ version, templates: { codex: hookTemplate("codex") }, instructions: { codex: previous } }));
    const result = await runCli([pending], { env: { ...env, CODEX_HOME: dir }, entry: path.join(root, "build/cli/refresh-hooks.js") });
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("User preface.\n\n" + instructionsFor("codex") + "\n");
    expect(fs.readFileSync(override, "utf8")).toBe(instructionsFor("codex") + "\n");
    fs.writeFileSync(file, previous + "\n");
    fs.writeFileSync(override, "Local override only.\n");
    const retry = await runCli([pending], { env: { ...env, CODEX_HOME: dir }, entry: path.join(root, "build/cli/refresh-hooks.js") });
    expect(retry.code, retry.stderr).toBe(0);
    expect(fs.readFileSync(override, "utf8")).toBe("Local override only.\n");
});

it("updates only the original Antigravity rule while independently refreshing its registered hooks and grants", async () => {
    const home = fs.mkdtempSync(path.join(tmp, "antigravity-refresh-"));
    const config = path.join(home, ".gemini/config");
    const rule = path.join(config, "rules/n2n-nexus.md");
    fs.mkdirSync(path.dirname(rule), { recursive: true });
    const hooks = {};
    setAntigravityHook(hooks, antigravityHook(process.execPath, entry, "discover"));
    fs.writeFileSync(path.join(config, "hooks.json"), JSON.stringify(hooks));
    const previous = renderRule("discover", "Previous default.");
    const current = renderRule("discover", DIRECT_MESSAGE_RULE);
    const digest = createHash("sha256").update(previous).digest("hex");
    const pending = path.join(home, "pending.json");
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    for (const [original, hash, expected] of [
        [previous, digest, current], [previous + "Ask first.\n", digest, previous + "Ask first.\n"],
        [undefined, digest, undefined], [previous, undefined, previous], ["My replacement.\n", digest, "My replacement.\n"],
    ] as const) {
        if (original === undefined) fs.rmSync(rule, { force: true }); else fs.writeFileSync(rule, original);
        const settings = path.join(config, "config.json");
        fs.rmSync(settings, { force: true });
        fs.writeFileSync(pending, JSON.stringify({ version, templates: { antigravity: "older" }, antigravityRuleHash: hash }));
        const result = await runCli([pending], { env: { ...env, HOME: home, USERPROFILE: home }, entry: path.join(root, "build/cli/refresh-hooks.js") });
        expect(result.code, result.stderr).toBe(0);
        expect(fs.existsSync(rule) ? fs.readFileSync(rule, "utf8") : undefined).toBe(expected);
        expect(fs.readFileSync(settings, "utf8")).toContain("--endpoint discover");
    }
});

it("preserves a newer installation and its pending refresh if another updater finished after this CLI loaded", async () => {
    const otherPrefix = path.join(tmp, "concurrent");
    const otherRoot = path.join(otherPrefix, path.relative(prefix, root));
    fs.cpSync(path.join(tmp, "staging"), otherRoot, { recursive: true });
    const manifestPath = path.join(otherRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: before }));

    const newer = "1.0.2";
    const id = createHash("sha256").update(fs.realpathSync(otherPrefix)).digest("hex").slice(0, 24);
    const stateDir = path.join(tmp, ".local/state/n2n-nexus/client-update", id);
    fs.mkdirSync(stateDir, { recursive: true });
    const pending = path.join(stateDir, "pending.json");
    const previous = JSON.stringify({ version: newer, templates: { pi: "newer registration awaiting refresh" } });
    fs.writeFileSync(pending, previous);
    const driver = path.join(otherRoot, "driver.js");
    // Loading the updater reads the old client version, as the combined command
    // does before waiting for the host. Another process then replaces that package.
    fs.writeFileSync(driver, `
        import fs from "node:fs";
        import { updateGlobalClient } from "./build/cli/auto-update.js";
        const file = new URL("./package.json", import.meta.url);
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), version: "${newer}" }));
        await updateGlobalClient();
    `);
    compatible = true;
    const result = await runCli([], { entry: driver, env: { ...env, npm_config_prefix: otherPrefix } });
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version).toBe(newer);
    expect(fs.readFileSync(pending, "utf8")).toBe(previous);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run the update again");
}, 30_000);

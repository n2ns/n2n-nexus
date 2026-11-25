import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { pkg } from "../config/index.js";
import { CONTRACT_VERSION, type HookClient } from "../contract.js";
import { entryScript } from "./entry.js";
import { INSTRUCTIONS, hookTemplate, npxFor, probeNode, satisfiesEngines, stableNodePath } from "./install.js";
import { registeredHooks } from "./registered-hooks.js";

export class NotGlobalClientError extends Error {}

function npmCommand(node: string, npm: string, args: string[]): string {
    const result = spawnSync(node, [npm, ...args], {
        cwd: os.homedir(), stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", windowsHide: true,
        timeout: 5 * 60_000,
        env: { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? "") },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.signal ?? result.status}).`);
    return result.stdout.trim();
}

/** A one-off npm install -g --prefix is not necessarily in a new session's npm configuration.
 * Its global bin link identifies it separately from a project dependency's node_modules/.bin. */
function prefixFromGlobalBin(entry: string): string | undefined {
    const windows = process.platform === "win32";
    const modules = path.resolve(path.dirname(entry), "../..");
    const prefix = windows ? path.dirname(modules) : path.resolve(modules, "../..");
    try {
        if (windows) {
            const shim = fs.readFileSync(path.join(prefix, "n2n-nexus.cmd"), "utf8");
            if (shim.includes("%dp0%\\node_modules\\n2n-nexus\\build\\index.js")) return prefix;
        } else if (fs.realpathSync(path.join(prefix, "bin", "n2n-nexus")) === fs.realpathSync(entry)) {
            return prefix;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
}

/** Refuse npx caches, source checkouts, linked packages and a different npm prefix. */
export function globalNpm() {
    const entry = entryScript();
    if (/[/\\]_npx[/\\]/.test(entry)) throw new NotGlobalClientError("Cannot update an npx cache.");
    const node = stableNodePath();
    const npm = path.join(path.dirname(fs.realpathSync(npxFor(node).npx)), "npm-cli.js");
    const prefix = prefixFromGlobalBin(entry) ?? npmCommand(node, npm, ["prefix", "-g"]);
    const root = npmCommand(node, npm, ["root", "-g", "--prefix", prefix]);
    const location = path.join(root, pkg.name);
    if (!fs.existsSync(location) || fs.lstatSync(location).isSymbolicLink() ||
        fs.realpathSync(path.resolve(entry, "../..")) !== fs.realpathSync(location)) {
        throw new NotGlobalClientError(`This command must run from the global npm installation in ${root}.`);
    }
    return { node, npm, prefix, entry };
}

type Candidate = {
    version?: string;
    nexusContractVersion?: number;
    engines?: { node?: string };
};

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Compare only stable numeric releases. A prerelease or development checkout is never switched. */
export function newerStable(candidate: string, installed: string): boolean {
    if (!stableVersion.test(candidate) || !stableVersion.test(installed)) return false;
    const a = candidate.split(".").map(BigInt);
    const b = installed.split(".").map(BigInt);
    const different = a.findIndex((value, i) => value !== b[i]);
    return different !== -1 && a[different] > b[different];
}

export type Pending = { version: string; claudeInstructions?: string; templates: Partial<Record<HookClient, string>> };

function finishRefresh(node: string, entry: string, pendingFile: string) {
    const worker = path.join(path.dirname(entry), "cli", "refresh-hooks.js");
    const result = spawnSync(node, [worker, pendingFile], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Refreshing hooks failed. The next update retries the pending registrations.");
    fs.unlinkSync(pendingFile);
}

export async function updateGlobalClient(): Promise<void> {
    const { node, npm, prefix, entry } = globalNpm();
    const id = createHash("sha256").update(fs.realpathSync(prefix)).digest("hex").slice(0, 24);
    const stateDir = path.join(os.homedir(), ".local", "state", "n2n-nexus", "client-update", id);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // The OS releases the SQLite write lock even if either npm or this process fails.
    const db = new DatabaseSync(path.join(stateDir, "lock.db"));
    try {
        db.exec("BEGIN IMMEDIATE");
        // A scheduled update may finish while the combined command is updating the host.
        // Only the updater whose code is still installed can act on its pending registrations.
        const manifest = path.resolve(path.dirname(entry), "../package.json");
        const installed = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
        if (installed !== pkg.version) {
            throw new Error(`Client changed from ${pkg.version} to ${installed} while this command was running; run the update again.`);
        }
        const pendingFile = path.join(stateDir, "pending.json");
        const pending: Pending | undefined = fs.existsSync(pendingFile)
            ? JSON.parse(fs.readFileSync(pendingFile, "utf8")) : undefined;
        if (pending?.version === pkg.version) finishRefresh(node, entry, pendingFile);
        const release = JSON.parse(npmCommand(node, npm, ["view", `${pkg.name}@latest`, "version", "nexusContractVersion", "engines", "--json", "--prefer-online"])) as Candidate;
        if (!release.version || !stableVersion.test(release.version)) throw new Error("The npm latest tag does not name a stable release.");
        if (!newerStable(release.version, pkg.version)) {
            process.stdout.write(`Client ${pkg.version}: no newer stable release (npm latest: ${release.version}).\n`);
            return;
        }
        if (release.nexusContractVersion !== CONTRACT_VERSION) {
            throw new Error(`Client ${release.version} requires a coordinated update: its contract is different or unknown. Installed ${pkg.version} remains active.`);
        }
        const hooks = registeredHooks(entry);
        const nodes = new Set([node, ...[...hooks.values()].map((hook) => hook.node)]);
        for (const installedNode of nodes) {
            const version = probeNode(installedNode).version;
            if (!version || !release.engines?.node || !satisfiesEngines(version, release.engines.node)) {
                throw new Error(`Client ${release.version} cannot run on the registered Node ${installedNode}. Update Node first.`);
            }
        }

        // Keep the old templates across npm replacing us, including a crash after installation
        // or a later retry of a partially completed refresh with no newer npm version.
        const next: Pending = { version: release.version, templates: {} };
        for (const client of hooks.keys()) next.templates[client] = hookTemplate(client);
        if (hooks.has("claude")) next.claudeInstructions = INSTRUCTIONS;
        const tmp = pendingFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(tmp, pendingFile);
        npmCommand(node, npm, ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--engine-strict", `${pkg.name}@${release.version}`]);
        finishRefresh(node, entry, pendingFile);
        process.stdout.write(`Updated global client ${pkg.version} → ${release.version}.\n`);
    } finally {
        db.close();
    }
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { pkg } from "../config/index.js";
import { CONTRACT_VERSION, type HookClient } from "../contract.js";
import { entryScript } from "./entry.js";
import { type InstructionClient, defaultAntigravityRuleHash, hasInstructions, hookTemplate, instructionsFor, npxFor, probeNode, satisfiesEngines, stableNodePath } from "./install.js";
import { registeredHooks } from "./registered-hooks.js";
import { clientUpdateStateDir, packagePrefix } from "./startup-update.js";

export class NotGlobalClientError extends Error {}

/** Only controlled messages may be retained. npm and config parsers can include URLs or file contents. */
class UpdateFailure extends Error {}
class ClientAlreadyChanged extends Error {}
const npmErrorCodes = new Set([
    "E401", "E403", "E404", "E429", "E500", "E502", "E503", "E504", "EACCES", "EPERM",
    "ENOSPC", "ENOENT", "EINTEGRITY", "EBADENGINE", "ETARGET", "ENOTFOUND", "EAI_AGAIN",
    "ENETUNREACH", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE",
    "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function npmCommand(node: string, npm: string, args: string[]): string {
    const result = spawnSync(node, [npm, ...args], {
        cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true,
        timeout: 5 * 60_000,
        env: { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? "") },
    });
    if (result.error || result.status !== 0) {
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code
            ?? /^npm (?:error|ERR!) code (\S+)\s*$/im.exec(result.stderr ?? "")?.[1];
        const reason = code && npmErrorCodes.has(code) ? code : result.signal ?? `exit ${result.status ?? "unknown"}`;
        throw new UpdateFailure(`npm ${args[0]} failed (${reason}).`);
    }
    return result.stdout.trim();
}

/** A one-off npm install -g --prefix is not necessarily in a new session's npm configuration.
 * Its global bin link identifies it separately from a project dependency's node_modules/.bin. */
function prefixFromGlobalBin(entry: string): string | undefined {
    const windows = process.platform === "win32";
    const prefix = packagePrefix(entry);
    if (!prefix) return undefined;
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

export type Pending = {
    version: string;
    antigravityRuleHash?: string;
    instructions?: Partial<Record<InstructionClient, string>>;
    /** Written by releases before `instructions`. */
    claudeInstructions?: string;
    templates: Partial<Record<HookClient, string>>;
};

function finishRefresh(node: string, entry: string, pendingFile: string) {
    const worker = path.join(path.dirname(entry), "cli", "refresh-hooks.js");
    const result = spawnSync(node, [worker, pendingFile], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new UpdateFailure("Refreshing hooks failed. The next update retries the pending registrations.");
    fs.unlinkSync(pendingFile);
}

export function clientUpdateLocation() {
    // A global bin link lets us record even a broken npm installation. Without a link,
    // verify the package with npm before writing anything to the user's state directory.
    const linkedPrefix = prefixFromGlobalBin(entryScript());
    const verified = linkedPrefix ? undefined : globalNpm();
    return { stateDir: clientUpdateStateDir(linkedPrefix ?? verified!.prefix), verified };
}

export async function updateGlobalClient(): Promise<void> {
    const { stateDir, verified } = clientUpdateLocation();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Only the lock owner publishes a result, including from an explicit update or retry.
    const db = new DatabaseSync(path.join(stateDir, "lock.db"));
    const failureFile = path.join(stateDir, "failure.txt");
    let locked = false;
    let stage = "resolve the global Node and npm installation";
    try {
        db.exec("BEGIN IMMEDIATE");
        locked = true;
        const { node, npm, entry, prefix } = verified ?? globalNpm();
        stage = "read the installed client and pending hook registrations";
        // A session-start update may finish while the combined command is updating the host.
        // Only the updater whose code is still installed can act on its pending registrations.
        const manifest = path.resolve(path.dirname(entry), "../package.json");
        const installed = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
        if (installed !== pkg.version) {
            throw new ClientAlreadyChanged(`Client changed from ${pkg.version} to ${installed} while this command was running; run the update again.`);
        }
        const pendingFile = path.join(stateDir, "pending.json");
        const pending: Pending | undefined = fs.existsSync(pendingFile)
            ? JSON.parse(fs.readFileSync(pendingFile, "utf8")) : undefined;
        if (pending?.version === pkg.version) finishRefresh(node, entry, pendingFile);
        stage = "read the latest release metadata from npm";
        const release = JSON.parse(npmCommand(node, npm, ["view", `${pkg.name}@latest`, "version", "nexusContractVersion", "engines", "--json", "--prefer-online"])) as Candidate;
        if (!release.version || !stableVersion.test(release.version)) throw new UpdateFailure("The npm latest tag does not name a stable release.");
        if (!newerStable(release.version, pkg.version)) {
            fs.rmSync(failureFile, { force: true });
            process.stdout.write(`Client ${pkg.version}: no newer stable release (npm latest: ${release.version}).\n`);
            return;
        }
        if (release.nexusContractVersion !== CONTRACT_VERSION) {
            throw new UpdateFailure(`Client ${release.version} requires a coordinated update: its contract is different or unknown.`);
        }
        stage = "read the registered client hooks";
        const hooks = registeredHooks(entry);
        const nodes = new Set([node, ...[...hooks.values()].map((hook) => hook.node)]);
        for (const installedNode of nodes) {
            const version = probeNode(installedNode).version;
            if (!version || !release.engines?.node || !satisfiesEngines(version, release.engines.node)) {
                throw new UpdateFailure(`Client ${release.version} cannot run on a registered Node version. Update Node first.`);
            }
        }

        // Keep the old templates across npm replacing us, including a crash after installation
        // or a later retry of a partially completed refresh with no newer npm version.
        stage = "prepare the hook registrations for the new client";
        const next: Pending = { version: release.version, templates: {} };
        for (const [client, registration] of hooks) {
            next.templates[client] = hookTemplate(client);
            if (client === "antigravity") next.antigravityRuleHash = defaultAntigravityRuleHash(registration.endpoint);
            if (hasInstructions(client)) (next.instructions ??= {})[client] = instructionsFor(client);
        }
        const tmp = pendingFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(tmp, pendingFile);
        stage = "install the new npm client";
        npmCommand(node, npm, ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--engine-strict", `${pkg.name}@${release.version}`]);
        stage = "refresh the installed hooks";
        finishRefresh(node, entry, pendingFile);
        fs.rmSync(failureFile, { force: true });
        process.stdout.write(`Updated global client ${pkg.version} → ${release.version}.\n`);
    } catch (error) {
        if (locked && !(error instanceof NotGlobalClientError) && !(error instanceof ClientAlreadyChanged)) {
            const reason = error instanceof UpdateFailure ? error.message : `Could not ${stage}.`;
            const tmp = failureFile + ".tmp";
            fs.writeFileSync(tmp, `${new Date().toISOString()}  ${reason}\n`, { mode: 0o600 });
            fs.renameSync(tmp, failureFile);
        }
        throw error;
    } finally {
        db.close();
    }
}

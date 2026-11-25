import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { REPO, runCli } from "./helpers/cli.js";
import { cleanupExecutables, writeExecutable } from "./helpers/executable.js";
import { npxFor } from "../src/cli/install.js";

// Real npm installation, with only the OS registration replaced inside the fixture package.
it("enables global installs, retries at registration or session start, and honors off across reinstall", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-default-client-"));
    const stage = path.join(tmp, "stage");
    const prefix = path.join(tmp, "prefix");
    const bin = path.join(tmp, "bin");
    const windows = process.platform === "win32";
    const globalEntry = path.join(prefix, windows ? "" : "lib", "node_modules/n2n-nexus/build/index.js");
    const dir = path.join(windows ? path.join(tmp, "Local") : path.join(tmp, ".local/share"), "n2n-nexus/updates");
    const log = path.join(tmp, "schedule.log");
    const runner = path.join(dir, windows ? "client.ps1" : "client.sh");
    const pendingRemoval = path.join(dir, "client-removal-pending");
    const fixtureEnv = {
        ...process.env, HOME: tmp, USERPROFILE: tmp, LOCALAPPDATA: path.join(tmp, "Local"),
        CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), CODEX_HOME: path.join(tmp, "codex"), PI_CODING_AGENT_DIR: path.join(tmp, "pi"),
        PATH: bin + path.delimiter + process.env.PATH, SCHEDULE_LOG: log, RUNNER: runner, PENDING_REMOVAL: pendingRemoval,
        npm_config_cache: path.join(tmp, "npm-cache"), npm_config_userconfig: path.join(tmp, "npmrc"),
        npm_config_audit: "false", npm_config_fund: "false", npm_config_offline: "true"
    };
    const cliEnv = { ...fixtureEnv, npm_config_prefix: prefix };
    const npm = path.join(path.dirname(fs.realpathSync(npxFor(process.execPath).npx)), "npm-cli.js");
    const runNpm = (args: string[], cwd: string, extra = {}) =>
        execFileSync(process.execPath, [npm, ...args], { cwd, env: { ...fixtureEnv, ...extra }, stdio: "pipe" });
    const onCount = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(line => line.startsWith("on ")).length : 0;
    try {
        fs.mkdirSync(stage);
        for (const folder of ["build", "contract", "autoupdate"]) fs.cpSync(path.join(REPO, folder), path.join(stage, folder), { recursive: true });
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
        fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
            name: pkg.name, version: pkg.version, type: "module", engines: pkg.engines, bin: pkg.bin, scripts: { postinstall: pkg.scripts.postinstall }
        }));
        // The live scheduler is never invoked. Keep its partial-registration behavior on an error.
        fs.writeFileSync(path.join(stage, "autoupdate/schedule.sh"), `
set -eu
case "$1" in
 status) [ -f "$RUNNER" ] && [ -f "$RUNNER.ready" ] && exit 0; exit 3;;
 on) echo "on $PATH" >> "$SCHEDULE_LOG"; echo "$NPM_CONFIG_PREFIX" > "$RUNNER"
     [ -z "\${FAIL_ON-}" ] || exit 7; touch "$RUNNER.ready";;
 off) rm -f "$RUNNER" "$RUNNER.ready" "$PENDING_REMOVAL";;
esac
`);
        fs.writeFileSync(path.join(stage, "autoupdate/schedule.ps1"), `
$ErrorActionPreference='Stop'
$r=ConvertFrom-Json $env:N2N_NEXUS_UPDATE_SCHEDULE
switch ($r.action) {
 status { if ((Test-Path $env:RUNNER) -and (Test-Path "$env:RUNNER.ready")) { exit 0 }; exit 3 }
 on { [IO.File]::AppendAllText($env:SCHEDULE_LOG, "on $env:PATH\n")
      [IO.File]::WriteAllText($env:RUNNER, $env:NPM_CONFIG_PREFIX)
      if ($env:FAIL_ON) { exit 7 }; [IO.File]::WriteAllText("$env:RUNNER.ready","") }
 off { Remove-Item -LiteralPath $env:RUNNER, "$env:RUNNER.ready", $env:PENDING_REMOVAL -ErrorAction SilentlyContinue }
}
`);
        writeExecutable(path.join(bin, "pi"), 'process.stdout.write("ok\\n")');
        runNpm(["pack", "--pack-destination", tmp, "--ignore-scripts"], stage);
        const pkgFile = path.join(tmp, `${pkg.name}-${pkg.version}.tgz`);
        const install = (...args: string[]) => runNpm(["install", "-g", "--prefix", prefix, ...args, pkgFile], tmp);

        const local = path.join(tmp, "local");
        fs.mkdirSync(local);
        runNpm(["install", "--prefix", local, pkgFile], local);
        expect(onCount()).toBe(0);
        expect(fs.existsSync(dir)).toBe(false);
        const localEntry = path.join(local, "node_modules/n2n-nexus/build/index.js");
        const notGlobal = await runCli(["auto-update", "on"], { entry: localEntry, env: cliEnv });
        expect(notGlobal.code).toBe(1);
        expect(notGlobal.stderr).toContain("global npm installation");
        expect(onCount()).toBe(0);

        // A temporary failure must not break npm installation or permanently suppress registration.
        runNpm(["install", "-g", "--prefix", prefix, pkgFile], tmp, { FAIL_ON: "1" });
        expect(onCount()).toBe(1);
        expect(fs.existsSync(runner + ".ready")).toBe(false);
        expect(fs.readFileSync(log, "utf8")).not.toMatch(/node_modules[/\\]\.bin|node-gyp-bin/);
        const connect = () => runCli(["install", "pi"], { entry: globalEntry, env: cliEnv });
        expect((await connect()).code).toBe(0);
        expect(onCount()).toBe(2);
        expect(fs.readFileSync(runner, "utf8").trim()).toBe(prefix);
        expect((await connect()).code).toBe(0);
        expect(onCount()).toBe(2);

        expect((await runCli(["auto-update", "off"], { entry: globalEntry, env: cliEnv })).code).toBe(0);
        install();
        expect((await connect()).code).toBe(0);
        expect(onCount()).toBe(2);
        expect(fs.existsSync(runner)).toBe(false);

        const sessionStart = async () => {
            const result = await runCli(["hook", "pi", "--endpoint", "http://127.0.0.1:1"], {
                entry: globalEntry, env: fixtureEnv, stdin: JSON.stringify({ hook_event_name: "SessionStart", session_id: "new" })
            });
            expect(result.code).toBe(0);
            expect(result.stdout).toBe("");
        };
        const choiceFile = path.join(dir, "client-choice");
        // An earlier removal disabled the runner but left an OS task to unregister.
        fs.writeFileSync(pendingRemoval, "");
        fs.writeFileSync(runner + ".ready", "");
        await sessionStart();
        await expect.poll(() => fs.existsSync(pendingRemoval), { timeout: 12_000 }).toBe(false);
        expect(fs.existsSync(runner + ".ready")).toBe(false);
        expect(fs.readFileSync(choiceFile, "utf8").trim()).toBe("off");
        expect(onCount()).toBe(2);

        fs.rmSync(dir, { recursive: true });
        install("--ignore-scripts");
        await sessionStart();
        await expect.poll(() => fs.existsSync(choiceFile), { timeout: 12_000 }).toBe(true);
        expect(fs.existsSync(runner + ".ready")).toBe(true);
        expect(onCount()).toBe(3);

        const target = JSON.parse(fs.readFileSync(choiceFile, "utf8"));
        expect(target.entry).toBe(globalEntry);
        expect(fs.existsSync(target.node)).toBe(true);
        for (const key of ["node", "entry"]) {
            // The old scheduled task is still enabled, but its previous Node or package was removed.
            fs.writeFileSync(choiceFile, JSON.stringify({ ...target, [key]: path.join(tmp, "removed") }));
            await sessionStart();
            await expect.poll(() => JSON.parse(fs.readFileSync(choiceFile, "utf8")), { timeout: 12_000 }).toEqual(target);
        }
        expect(onCount()).toBe(5);

        fs.rmSync(dir, { recursive: true });
        install();
        expect(fs.existsSync(runner + ".ready")).toBe(true);
        expect(onCount()).toBe(6);
        const explicit = await runCli(["auto-update", "on"], { entry: globalEntry, env: { ...fixtureEnv, npm_config_prefix: path.join(tmp, "other-prefix") } });
        expect(explicit.code, explicit.stderr).toBe(0);
        expect(fs.readFileSync(runner, "utf8").trim()).toBe(prefix);
    } finally {
        cleanupExecutables();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}, 60_000);

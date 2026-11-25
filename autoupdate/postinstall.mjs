// A local npm install (including development's npm ci before TypeScript builds) has no user job.
const lifecycle = process.env.npm_config_global === "true" && process.env.npm_lifecycle_event === "postinstall";
if (lifecycle || process.argv[2] === "--session-start") {
    if (lifecycle) {
        const path = await import("node:path");
        // npm prepends node_modules/.bin for every ancestor, followed by its node-gyp-bin.
        // A daily job must retain the user's original PATH, including the chosen Node installation.
        const dirs = (process.env.PATH || "").split(path.delimiter);
        process.env.PATH = dirs.filter(dir => !/[/\\](?:node_modules[/\\]\.bin|node-gyp-bin)$/i.test(dir)).join(path.delimiter);
    }
    try {
        const { ensureClientUpdateSchedule } = await import("../build/cli/update-schedule.js");
        await ensureClientUpdateSchedule();
    } catch (error) {
        process.stderr.write(`[n2n-nexus] Daily client updates could not be registered: ${error.message}\n`);
    }
}

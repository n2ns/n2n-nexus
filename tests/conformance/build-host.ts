// Vitest globalSetup of the conformance tests when NEXUS_HOST_BIN is not given
// (see vitest.conformance.config.ts): build the test host they start, so a run
// never tests the binary of an earlier build of the sources.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
    execSync("npm run host:build-test", { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: "inherit" });
}

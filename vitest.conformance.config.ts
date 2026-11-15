import { defineConfig } from "vitest/config";

// Black-box conformance tests against the host executable in NEXUS_HOST_BIN,
// by default the test build of `npm run host:build-test`, which the run then
// builds first (tests/conformance/build-host.ts); see tests/conformance/harness.ts.
const ownBuild = !process.env.NEXUS_HOST_BIN;
process.env.NEXUS_HOST_BIN ||= `host/bin/test/n2n-nexus-host${process.platform === "win32" ? ".exe" : ""}`;

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/conformance/**/*.test.ts"],
        fileParallelism: false,  // one host process at a time
        testTimeout: 30_000,
        globalSetup: ownBuild ? ["tests/conformance/build-host.ts"] : [],
    },
});

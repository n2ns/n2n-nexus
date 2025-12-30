import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        fileParallelism: false,  // Run test files sequentially to avoid directory conflicts
    },
});

import { defineConfig } from "vitest/config";

/**
 * Offline by default: the suite must be runnable with no network and no proxy, and it must
 * never pick up build output or a scratch directory left at the repo root. A file vitest
 * cannot parse is a red build for reasons that have nothing to do with the code.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules/**", "dist/**", "**/.supervisor-smoke/**"],
    environment: "node",
  },
});

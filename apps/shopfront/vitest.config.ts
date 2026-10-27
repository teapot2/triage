import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests use the real Postgres, so a fork per file keeps pools separate.
    pool: "forks",
    // Bound the run: a fork stuck on open sockets is killed, not waited on.
    testTimeout: 10_000,
    hookTimeout: 5_000,
    teardownTimeout: 2_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["agentcave-source"] },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});

import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Load @agentcave/client from source (its "agentcave-source" export), so tests don't need it built first.
const conditions = ["agentcave-source", ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    server: { deps: { inline: ["@agentcave/client"] } },
  },
});

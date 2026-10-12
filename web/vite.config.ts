import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.AGENTCAVE_API ?? "http://localhost:7420";

export default defineConfig({
  // Relative asset URLs: one build works under any prefix. The server decides the prefix at runtime
  // (BASE_PATH) and adds a matching <base href> to index.html.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["agentcave-source"] },
  server: {
    port: 5173,
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
});

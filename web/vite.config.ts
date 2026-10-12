import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.AGENTCAVE_API ?? "http://localhost:7420";

export default defineConfig({
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

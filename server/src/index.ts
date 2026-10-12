import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createAgentCave, VERSION } from "./app.js";
import { normalizeBasePath } from "./http/base-path.js";
import { log, setLogLevel } from "./log.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function findWebDist(): string | null {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(here, "../../web/dist"),
    path.resolve(here, "../web/dist"),
  ];
  for (const c of candidates) if (c && existsSync(path.join(c, "index.html"))) return c;
  return null;
}

async function main(): Promise<void> {
  setLogLevel(process.env.LOG_LEVEL ?? "info");
  const port = Number(process.env.PORT ?? 7420);
  const hostname = process.env.HOST ?? "0.0.0.0";
  const dataDir = process.env.DATA_DIR ?? path.resolve("data");
  const webDist = findWebDist();
  const basePath = normalizeBasePath(process.env.BASE_PATH);

  const cave = await createAgentCave({ dataDir, webDist, basePath });
  cave.start();

  const server = serve({ fetch: cave.app.fetch, port, hostname }, (info) => {
    log.info(
      `AgentCave ${VERSION} listening on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${info.port}${basePath}`,
      {
        dataDir,
        ui: webDist ? "enabled" : "not built",
        ...(basePath ? { basePath } : {}),
      },
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down…`);
    server.close();
    await cave.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("AgentCave failed to start", { err });
  process.exit(1);
});

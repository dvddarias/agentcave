import type { AgentInput } from "@agentcave/client";
import { Hono } from "hono";
import { mimeFor } from "../cycles.js";
import { badRequest } from "../errors.js";
import { agentInputSchema } from "../schemas.js";
import { contentDisposition, type HttpDeps, intParam, pathAfter, readJson } from "./util.js";

export function agentRoutes(deps: HttpDeps): Hono {
  const { agents } = deps.ctx;
  const app = new Hono();

  app.get("/", (c) => c.json({ agents: agents.list({ archived: c.req.query("archived") === "true" }) }));

  app.post("/", async (c) => {
    const input = (await readJson(c, agentInputSchema)) as AgentInput;
    return c.json(await agents.create(input), 201);
  });

  app.post("/import", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let data: Uint8Array;
    if (type.includes("application/json")) {
      const body = (await c.req.json().catch(() => null)) as { content?: string; encoding?: string } | null;
      if (!body?.content) throw badRequest("Send { content, encoding? } or the raw .md/.zip file");
      data = new Uint8Array(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
    } else {
      data = new Uint8Array(await c.req.arrayBuffer());
    }
    if (data.length === 0) throw badRequest("Empty file");
    return c.json(await agents.import(data, type), 201);
  });

  app.get("/:slug", (c) => c.json(agents.get(c.req.param("slug"))));

  app.put("/:slug", async (c) => {
    const input = (await readJson(c, agentInputSchema)) as AgentInput;
    return c.json(await agents.update(c.req.param("slug"), input));
  });

  app.delete("/:slug", (c) => {
    agents.archive(c.req.param("slug"), true);
    return c.body(null, 204);
  });

  app.post("/:slug/unarchive", (c) => {
    agents.archive(c.req.param("slug"), false);
    return c.json(agents.get(c.req.param("slug")));
  });

  app.get("/:slug/versions", (c) => c.json({ versions: agents.versions(c.req.param("slug")) }));

  app.get("/:slug/versions/:n", (c) =>
    c.json(agents.version(c.req.param("slug"), intParam(c.req.param("n"), "version"))),
  );

  app.post("/:slug/versions/:n/restore", async (c) =>
    c.json(await agents.restore(c.req.param("slug"), intParam(c.req.param("n"), "version"))),
  );

  app.get("/:slug/files/*", async (c) => {
    const filePath = pathAfter(c, "/files/");
    const v = c.req.query("version");
    const data = await agents.readFile(c.req.param("slug"), filePath, v ? intParam(v, "version") : undefined);
    return c.body(new Uint8Array(data), 200, {
      "content-type": mimeFor(filePath),
      "content-disposition": contentDisposition(filePath.split("/").pop() ?? "file", true),
    });
  });

  app.get("/:slug/export", async (c) => {
    const file = await agents.export(c.req.param("slug"));
    return c.body(file.data as Uint8Array<ArrayBuffer>, 200, {
      "content-type": file.contentType,
      "content-disposition": contentDisposition(file.filename),
    });
  });

  return app;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectBasePath, normalizeBasePath, stripBasePath } from "../src/http/base-path.js";
import { log } from "../src/log.js";
import { createTestCave, submit, type TestCave } from "./helpers.js";

let t: TestCave;
let webDist: string;
afterEach(async () => {
  await t?.close();
  if (webDist) fs.rmSync(webDist, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A built UI as Vite emits it with `base: "./"`: relative asset URLs. */
function webFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentcave-web-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`,
  );
  fs.writeFileSync(path.join(dir, "assets", "index-abc.js"), "console.log('cave');\n");
  fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

async function setup(basePath?: string): Promise<void> {
  webDist = webFixture();
  t = await createTestCave({ webDist, basePath });
}

/** A request as the proxy forwards it (`headers` carries X-Forwarded-Prefix when it stripped a prefix). */
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await t.cave.app.request(url, { headers });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text(), res };
}

function expectIndex(r: Awaited<ReturnType<typeof get>>, base: string): void {
  expect(r.status).toBe(200);
  expect(r.type).toContain("text/html");
  expect(r.res.headers.get("cache-control")).toBe("no-cache");
  expect(r.text).toContain(
    `<head><base href="${base}/" /><script>window.__AGENTCAVE_BASE__="${base}"</script>`,
  );
  expect(r.text).toContain(`src="./assets/index-abc.js"`);
}

/** A finished cycle with one workspace file, to fetch its files through the prefix. */
async function finishedCycle(): Promise<string> {
  t.setScript("test/model", () => submit("done"));
  await t.createAgent({ slug: "a" });
  const c = await t.startCycle({ agent: "a", prompt: "go", files: [{ path: "docs/a b.md", content: "hi" }] });
  await t.waitFor(c.id);
  return c.id;
}

describe("normalizeBasePath", () => {
  it("adds a leading slash and drops trailing ones", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath(" cave ")).toBe("/cave");
    expect(normalizeBasePath("/cave/")).toBe("/cave");
    expect(normalizeBasePath("//apps//cave//")).toBe("/apps/cave");
  });

  it("rejects what is not a plain path", () => {
    for (const bad of ["/ca ve", "/../x", "/a/./b", '/"><script>', "/cave?x=1", "https://x.com/cave"]) {
      expect(() => normalizeBasePath(bad), bad).toThrow(/Invalid BASE_PATH/);
    }
  });
});

describe("stripBasePath / injectBasePath", () => {
  it("strips the prefix only on a segment boundary", () => {
    expect(stripBasePath("/cave", "/cave")).toBe("/");
    expect(stripBasePath("/cave/", "/cave")).toBe("/");
    expect(stripBasePath("/cave/api/v1/health", "/cave")).toBe("/api/v1/health");
    expect(stripBasePath("/api/v1/health", "/cave")).toBe("/api/v1/health");
    expect(stripBasePath("/caveman/x", "/cave")).toBe("/caveman/x");
    expect(stripBasePath("/cave/x", "")).toBe("/cave/x");
  });

  it("puts the base first in <head>", () => {
    expect(injectBasePath('<html><head lang="x"><title>t</title></head></html>', "/cave")).toBe(
      '<html><head lang="x"><base href="/cave/" /><script>window.__AGENTCAVE_BASE__="/cave"</script><title>t</title></head></html>',
    );
    expect(injectBasePath("<header></header>", "")).toBe(
      '<base href="/" /><script>window.__AGENTCAVE_BASE__=""</script><header></header>',
    );
  });
});

describe("served at the root (no BASE_PATH)", () => {
  it("serves the UI, assets, API and deep links as before", async () => {
    await setup();
    expectIndex(await get("/"), "");
    expectIndex(await get("/index.html"), "");
    expectIndex(await get("/cycles/cyc_123"), "");

    const asset = await get("/assets/index-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.type).toContain("javascript");
    expect(asset.text).toContain("cave");
    expect((await get("/favicon.svg")).status).toBe(200);

    const health = await get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text).ok).toBe(true);
    expect((await get("/api/v1/nope")).status).toBe(404);

    const spec = JSON.parse((await get("/api/v1/openapi.json")).text);
    expect(spec.servers).toEqual([{ url: "/api/v1" }]);

    // Without BASE_PATH a prefix is just an unknown client route.
    expect((await get("/cave/api/v1/health")).type).toContain("text/html");
  });

  it("warns when the proxy says it publishes under a prefix", async () => {
    await setup();
    const warn = vi.spyOn(log, "warn");
    await get("/api/v1/health", { "x-forwarded-prefix": "/cave" });
    await get("/api/v1/health", { "x-forwarded-prefix": "/cave" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("set BASE_PATH=/cave");
  });
});

describe("BASE_PATH=/cave", () => {
  it("works behind a proxy that strips the prefix (Caddy handle_path)", async () => {
    await setup("/cave/");
    const warn = vi.spyOn(log, "warn");
    const proxy = { "x-forwarded-prefix": "/cave" };

    // https://host/cave/ → /
    expectIndex(await get("/", proxy), "/cave");
    // https://host/cave/cycles/cyc_123 (a deep link, or a reload there) → /cycles/cyc_123
    expectIndex(await get("/cycles/cyc_123", proxy), "/cave");
    // https://host/cave/assets/… → /assets/…
    const asset = await get("/assets/index-abc.js", proxy);
    expect(asset.status).toBe(200);
    expect(asset.type).toContain("javascript");
    expect((await get("/favicon.svg", proxy)).status).toBe(200);

    // https://host/cave/api/v1/… → /api/v1/…
    const health = await get("/api/v1/health", proxy);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text).ok).toBe(true);
    const spec = JSON.parse((await get("/api/v1/openapi.json", proxy)).text);
    expect(spec.servers).toEqual([{ url: "/cave/api/v1" }]);

    const id = await finishedCycle();
    const file = await get(`/api/v1/cycles/${id}/files/docs/a%20b.md`, proxy);
    expect(file.text).toBe("hi");
    expect(warn).not.toHaveBeenCalled();
  });

  it("works with the prefix still on the path", async () => {
    await setup("/cave");
    expectIndex(await get("/cave"), "/cave");
    expectIndex(await get("/cave/"), "/cave");
    expectIndex(await get("/cave/index.html"), "/cave");
    expectIndex(await get("/cave/cycles/cyc_123"), "/cave");

    const asset = await get("/cave/assets/index-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.type).toContain("javascript");
    expect((await get("/cave/favicon.svg")).status).toBe(200);

    expect(JSON.parse((await get("/cave/api/v1/health")).text).ok).toBe(true);
    const missing = await get("/cave/api/v1/nope");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text).error.code).toBe("not_found");

    // Everything the UI fetches under the base: file previews, zip, the event log.
    const id = await finishedCycle();
    expect((await get(`/cave/api/v1/cycles/${id}/files/docs/a%20b.md`)).text).toBe("hi");
    const zip = await t.cave.app.request(`/cave/api/v1/cycles/${id}/files.zip`);
    expect(zip.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer())))).toContain("docs/a b.md");
    const events = JSON.parse((await get(`/cave/api/v1/cycles/${id}/events?format=json`)).text).events;
    expect(events.some((e: { type: string }) => e.type === "answer")).toBe(true);

    // Only whole segments: /caveman is not under /cave.
    const other = await get("/caveman/api/v1/health");
    expect(other.type).toContain("text/html");
  });
});

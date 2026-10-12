import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileChanges } from "@agentcave/client";

export interface ManifestEntry {
  sha256: string;
  size: number;
}
/** Relative path (posix) → content hash. */
export type Manifest = Record<string, ManifestEntry>;

interface StatCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

/**
 * Content-addressed file store under `<dataDir>/blobs/ab/abcdef…`.
 * Input files, agent files and workspace snapshots are stored once and referenced by hash.
 */
export class BlobStore {
  private readonly statCache = new Map<string, StatCacheEntry>();

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  pathOf(sha: string): string {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  async put(data: Buffer): Promise<ManifestEntry> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const target = this.pathOf(sha256);
    if (!(await exists(target))) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, target);
    } else {
      await touch(target);
    }
    return { sha256, size: data.length };
  }

  /** Stores a file from disk (streamed hash, then copy). */
  async putFile(file: string, knownSha?: string): Promise<ManifestEntry> {
    const stat = await fs.stat(file);
    const sha256 = knownSha ?? (await hashFile(file));
    const target = this.pathOf(sha256);
    if (!(await exists(target))) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.copyFile(file, tmp);
      await fs.rename(tmp, target);
    } else {
      await touch(target);
    }
    return { sha256, size: stat.size };
  }

  async read(sha: string): Promise<Buffer> {
    return fs.readFile(this.pathOf(sha));
  }

  /** Hashes every regular file under `dir` into the store and returns its manifest. */
  async snapshotDir(dir: string, opts: { exclude?: (rel: string) => boolean } = {}): Promise<Manifest> {
    const manifest: Manifest = {};
    for (const rel of await listFiles(dir)) {
      if (opts.exclude?.(rel)) continue;
      const abs = path.join(dir, rel);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue; // vanished while walking
      }
      const cached = this.statCache.get(abs);
      let sha: string | undefined;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) sha = cached.sha256;
      const entry = await this.putFile(abs, sha);
      this.statCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, sha256: entry.sha256 });
      if (this.statCache.size > 50_000) this.statCache.delete(this.statCache.keys().next().value!);
      manifest[rel] = entry;
    }
    return manifest;
  }

  /** Writes manifest files into `dir`. With `clean`, the directory is emptied first. */
  async materialize(dir: string, manifest: Manifest, opts: { clean?: boolean } = {}): Promise<void> {
    if (opts.clean) await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    for (const [rel, entry] of Object.entries(manifest)) {
      const dest = path.join(dir, ...rel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rm(dest, { recursive: true, force: true });
      await fs.copyFile(this.pathOf(entry.sha256), dest);
    }
  }

  /** Deletes blobs not in `referenced` that are older than `minAgeMs` (avoids racing in-flight writes). */
  async gc(referenced: Set<string>, minAgeMs = 60 * 60 * 1000): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - minAgeMs;
    let buckets: string[] = [];
    try {
      buckets = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const bucket of buckets) {
      const bucketDir = path.join(this.dir, bucket);
      let names: string[] = [];
      try {
        names = await fs.readdir(bucketDir);
      } catch {
        continue;
      }
      for (const name of names) {
        const sha = name.endsWith(".tmp") ? null : name;
        if (sha && referenced.has(sha)) continue;
        const file = path.join(bucketDir, name);
        try {
          const stat = await fs.stat(file);
          if (stat.mtimeMs > cutoff) continue;
          await fs.rm(file, { force: true });
          removed++;
        } catch {
          // ignore
        }
      }
    }
    return removed;
  }
}

export function diffManifests(before: Manifest, after: Manifest): FileChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, e] of Object.entries(after)) {
    const prev = before[p];
    if (!prev) added.push(p);
    else if (prev.sha256 !== e.sha256) modified.push(p);
  }
  for (const p of Object.keys(before)) if (!after[p]) deleted.push(p);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

export async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function touch(p: string): Promise<void> {
  const now = new Date();
  await fs.utimes(p, now, now).catch(() => {});
}

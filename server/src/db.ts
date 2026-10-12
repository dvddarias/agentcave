import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type DB = DatabaseSync;
export type Param = SQLInputValue;

const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE agent_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    note TEXT,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (agent_id, version)
  );

  CREATE TABLE agent_version_files (
    version_id TEXT NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (version_id, path)
  );

  CREATE TABLE cycles (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    agent_version_id TEXT NOT NULL REFERENCES agent_versions(id),
    agent_slug TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_version INTEGER NOT NULL,
    parent_id TEXT REFERENCES cycles(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    rerun_of TEXT,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    limits TEXT NOT NULL,
    output_schema TEXT,
    labels TEXT NOT NULL DEFAULT '{}',
    webhook_url TEXT,
    system_prompt TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_estimated INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    sub_input_tokens INTEGER NOT NULL DEFAULT 0,
    sub_output_tokens INTEGER NOT NULL DEFAULT 0,
    sub_cost_usd REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    activity TEXT,
    last_paragraph TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cycles_status ON cycles (status);
  CREATE INDEX cycles_agent ON cycles (agent_id, created_at);
  CREATE INDEX cycles_parent ON cycles (parent_id);
  CREATE INDEX cycles_root ON cycles (root_id);
  CREATE INDEX cycles_created ON cycles (created_at);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    input_manifest TEXT NOT NULL DEFAULT '{}',
    start_snapshot TEXT,
    end_snapshot TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    answer TEXT,
    changes TEXT,
    error_code TEXT,
    error_message TEXT,
    nudges INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_estimated INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (cycle_id, idx)
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX events_cycle ON events (cycle_id, seq);

  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    url TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX webhook_due ON webhook_deliveries (status, next_retry_at);
  CREATE INDEX webhook_cycle ON webhook_deliveries (cycle_id);
  `,
];

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

const depth = new WeakMap<DB, number>();

/** Runs `fn` in a transaction (nested calls join the outer transaction). */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export function one<T>(db: DB, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DB, sql: string, ...params: Param[]): { changes: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes) };
}

export const nowIso = (): string => new Date().toISOString();

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

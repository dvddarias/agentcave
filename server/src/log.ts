const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[level as Level] ?? LEVELS.info;
}

function write(level: Exclude<Level, "silent">, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
    extra && Object.keys(extra).length ? ` ${JSON.stringify(extra, errorReplacer)}` : ""
  }`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};

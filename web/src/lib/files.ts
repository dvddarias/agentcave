import type { FileInput } from "@agentcave/client";

export interface PickedFile {
  path: string;
  size: number;
  input: FileInput;
}

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|proto|env|gitignore|dockerfile|log|svg|tex|rst|lua|r|swift|scala|vue|svelte)$/i;

function looksText(name: string, bytes: Uint8Array): boolean {
  if (TEXT_EXT.test(name)) return true;
  const sample = bytes.subarray(0, 4096);
  for (const b of sample) if (b === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function readFile(file: File, path: string): Promise<PickedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const input: FileInput = looksText(path, bytes)
    ? { path, content: new TextDecoder().decode(bytes) }
    : { path, content: toBase64(bytes), encoding: "base64" };
  return { path, size: file.size, input };
}

// Folder support (drag & drop of directories) via the File System entries API.
type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (e: Entry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: Entry, out: { file: File; path: string }[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, "") });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

const IGNORED = /(^|\/)(node_modules|\.git|\.DS_Store|__pycache__|\.venv)(\/|$)/;

export async function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const found: { file: File; path: string }[] = [];
  const entries = [...dt.items]
    .map((i) => i.webkitGetAsEntry?.() as unknown as Entry | null)
    .filter((e): e is Entry => !!e);
  if (entries.length > 0) {
    for (const e of entries) await walk(e, found);
  } else {
    for (const f of dt.files) found.push({ file: f, path: f.name });
  }
  return Promise.all(found.filter((f) => !IGNORED.test(f.path)).map((f) => readFile(f.file, f.path)));
}

export async function filesFromInput(list: FileList | null): Promise<PickedFile[]> {
  if (!list) return [];
  const files = [...list].map((f) => ({
    file: f,
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
  }));
  return Promise.all(files.filter((f) => !IGNORED.test(f.path)).map((f) => readFile(f.file, f.path)));
}

export function download(name: string, data: BlobPart, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

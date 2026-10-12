import { useRef, useState } from "react";
import { filesFromDataTransfer, filesFromInput, type PickedFile } from "../lib/files";
import { formatBytes } from "../lib/format";
import { IconFile, IconFolder, IconUpload, IconX } from "./icons";
import { cx, Spinner } from "./ui";

export function FileDrop({
  files,
  onChange,
  compact,
  label = "Drop files or folders here",
}: {
  files: PickedFile[];
  onChange: (files: PickedFile[]) => void;
  compact?: boolean;
  label?: string;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const add = async (picked: Promise<PickedFile[]>) => {
    setBusy(true);
    try {
      const next = new Map(files.map((f) => [f.path, f]));
      for (const f of await picked) next.set(f.path, f);
      onChange([...next.values()].sort((a, b) => a.path.localeCompare(b.path)));
    } finally {
      setBusy(false);
    }
  };
  const total = files.reduce((n, f) => n + f.size, 0);

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add(filesFromDataTransfer(e.dataTransfer));
        }}
        className={cx(
          "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-colors",
          compact ? "px-4 py-4" : "px-6 py-7",
          over ? "border-torch-500 bg-torch-500/5" : "border-cave-600 bg-cave-900/50",
        )}
      >
        {busy ? <Spinner className="text-torch-400" /> : <IconUpload className="text-cave-400" size={20} />}
        <div className="text-sm text-cave-300">{label}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-cave-700 px-2 py-1 text-xs text-cave-300 hover:border-cave-500 hover:text-cave-100"
          >
            Choose files
          </button>
          <button
            type="button"
            onClick={() => dirRef.current?.click()}
            className="rounded-md border border-cave-700 px-2 py-1 text-xs text-cave-300 hover:border-cave-500 hover:text-cave-100"
          >
            Choose a folder
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add(filesFromInput(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={dirRef}
          type="file"
          hidden
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            void add(filesFromInput(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
      {files.length > 0 ? (
        <div className="mt-2 rounded-lg border border-cave-750">
          <div className="flex items-center justify-between border-b border-cave-750 px-3 py-1.5 text-[11px] text-cave-400">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(total)}
            </span>
            <button type="button" className="hover:text-cave-100" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {files.map((f) => (
              <li
                key={f.path}
                className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-cave-800/60"
              >
                {f.path.includes("/") ? (
                  <IconFolder size={13} className="text-cave-500" />
                ) : (
                  <IconFile size={13} className="text-cave-500" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-cave-200">{f.path}</span>
                {f.input.encoding === "base64" ? (
                  <span className="text-[10px] text-cave-500">binary</span>
                ) : null}
                <span className="text-cave-500">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => onChange(files.filter((x) => x.path !== f.path))}
                  className="text-cave-500 opacity-0 group-hover:opacity-100 hover:text-rose-300"
                  title="Remove"
                >
                  <IconX size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

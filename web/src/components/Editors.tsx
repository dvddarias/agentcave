import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useState } from "react";
import { IconCode, IconEye } from "./icons";
import { Markdown } from "./Markdown";
import { cx } from "./ui";

const baseTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#d6dce3" },
    ".cm-content": { caretColor: "#fbbf24", padding: "12px 0" },
    ".cm-line": { padding: "0 14px" },
    ".cm-gutters": { backgroundColor: "#0f1114", color: "#4d5562", border: "none" },
    ".cm-header-1, .cm-header-2, .cm-header-3": { color: "#fcd34d", fontWeight: "600" },
  },
  { dark: true },
);

export function MarkdownEditor({
  value,
  onChange,
  minHeight = 420,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: number;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<"split" | "edit" | "preview">("split");
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      baseTheme,
    ],
    [],
  );
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-cave-750 bg-cave-900">
      <div className="flex items-center justify-between border-b border-cave-750 bg-cave-850 px-3 py-1.5">
        <span className="text-xs text-cave-400">
          Markdown · {value.length.toLocaleString()} chars · ~{Math.ceil(value.length / 4).toLocaleString()}{" "}
          tokens
        </span>
        <div className="flex gap-0.5 rounded-lg bg-cave-900 p-0.5">
          {(["edit", "split", "preview"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cx(
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-xs capitalize",
                mode === m ? "bg-cave-700 text-cave-100" : "text-cave-400 hover:text-cave-200",
              )}
            >
              {m === "edit" ? <IconCode size={12} /> : m === "preview" ? <IconEye size={12} /> : null}
              {m}
            </button>
          ))}
        </div>
      </div>
      <div
        className="grid flex-1 overflow-hidden"
        style={{ gridTemplateColumns: mode === "split" ? "1fr 1fr" : "1fr", minHeight }}
      >
        {mode !== "preview" ? (
          <div className="cm-theme-cave overflow-auto">
            <CodeMirror
              value={value}
              onChange={onChange}
              extensions={extensions}
              theme="dark"
              placeholder={placeholder}
              basicSetup={{ foldGutter: false, highlightActiveLine: true, lineNumbers: true }}
              height="100%"
              style={{ height: "100%" }}
            />
          </div>
        ) : null}
        {mode !== "edit" ? (
          <div className={cx("overflow-auto px-5 py-4", mode === "split" && "border-l border-cave-750")}>
            {value.trim() ? (
              <Markdown text={value} />
            ) : (
              <p className="text-sm text-cave-500">Nothing to preview yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function JsonEditor({
  value,
  onChange,
  height = 260,
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  height?: number;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => [json(), EditorView.lineWrapping, baseTheme], []);
  let error: string | null = null;
  if (value.trim()) {
    try {
      JSON.parse(value);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <div>
      <div className="cm-theme-cave overflow-hidden rounded-lg border border-cave-700 bg-cave-900">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={extensions}
          theme="dark"
          readOnly={readOnly}
          height={`${height}px`}
          basicSetup={{ foldGutter: true, lineNumbers: true }}
        />
      </div>
      {error ? <p className="mt-1 text-[11px] text-rose-400">Invalid JSON: {error}</p> : null}
    </div>
  );
}

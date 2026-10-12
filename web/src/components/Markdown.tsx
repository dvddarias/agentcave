import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton, cx } from "./ui";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

export function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang))
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (code.length < 20_000) return hljs.highlightAuto(code).value;
  } catch {
    // fall through
  }
  return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export function CodeBlock({
  code,
  lang,
  className,
  copy = true,
  maxHeight,
}: {
  code: string;
  lang?: string;
  className?: string;
  copy?: boolean;
  maxHeight?: number;
}) {
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div className={cx("group relative", className)}>
      <pre
        className="hljs overflow-auto rounded-lg border border-cave-750 bg-cave-950 p-3 font-mono text-[0.78rem] leading-relaxed"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the code; the fallback escapes &<> itself */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {copy ? (
        <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={code} className="bg-cave-850/90" />
        </div>
      ) : null}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className: cls, children }) => {
            const match = /language-([\w-]+)/.exec(cls ?? "");
            const content = String(children ?? "");
            const isBlock = !!match || content.includes("\n");
            if (!isBlock) return <code>{children}</code>;
            return <CodeBlock code={content.replace(/\n$/, "")} lang={match?.[1]} className="my-3" />;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

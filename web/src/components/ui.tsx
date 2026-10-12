import type { CycleStatus } from "@agentcave/client";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from "react";
import { IconCheck, IconCopy, IconX } from "./icons";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" &&
          "bg-torch-500 text-cave-950 hover:bg-torch-400 shadow-[0_0_0_1px_rgba(245,158,11,.4),0_4px_18px_-6px_rgba(245,158,11,.55)]",
        variant === "secondary" &&
          "border border-cave-700 bg-cave-800 text-cave-100 hover:border-cave-600 hover:bg-cave-750",
        variant === "ghost" && "text-cave-300 hover:bg-cave-800 hover:text-cave-100",
        variant === "danger" && "border border-rose-900/70 bg-rose-950/40 text-rose-300 hover:bg-rose-900/40",
        className,
      )}
    >
      {loading ? <Spinner size={14} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx("animate-spin", className)}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" fill="none" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-cave-750 bg-cave-850/80", className)}>{children}</div>;
}

const STATUS_STYLE: Record<CycleStatus, string> = {
  queued: "border-cave-600 bg-cave-800 text-cave-300",
  running: "border-sky-700/60 bg-sky-950/50 text-sky-300",
  completed: "border-emerald-800/70 bg-emerald-950/40 text-emerald-300",
  failed: "border-rose-800/70 bg-rose-950/40 text-rose-300",
  stopped: "border-torch-700/60 bg-torch-700/10 text-torch-300",
};

export function StatusBadge({ status, className }: { status: CycleStatus; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        STATUS_STYLE[status],
        className,
      )}
    >
      <span
        className={cx(
          "size-1.5 rounded-full bg-current",
          (status === "running" || status === "queued") && "animate-pulse",
        )}
      />
      {status}
    </span>
  );
}

export function Pill({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-md border border-cave-700 bg-cave-800/80 px-1.5 py-0.5 text-[11px] text-cave-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as `children`
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-cave-300">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-snug text-cave-400">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "rounded-lg border border-cave-700 bg-cave-900 px-3 py-2 text-sm text-cave-100 placeholder:text-cave-500 focus:border-torch-600 focus:outline-none focus:ring-1 focus:ring-torch-600/50";

/** Full width unless the caller gives its own width class. */
const width = (className?: string) => (/(^|\s)(w-|min-w-|max-w-)/.test(className ?? "") ? null : "w-full");

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, width(className), className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, width(className), "resize-y", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, width(className), "appearance-auto pr-8", className)}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-cave-750 bg-cave-900/60 p-2.5 text-left hover:border-cave-600"
    >
      <span
        className={cx(
          "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-torch-500" : "bg-cave-600",
        )}
      >
        <span
          className={cx("size-4 rounded-full bg-cave-950 transition-transform", checked && "translate-x-4")}
        />
      </span>
      <span>
        <span className="block text-sm text-cave-100">{label}</span>
        {hint ? <span className="block text-[11px] text-cave-400">{hint}</span> : null}
      </span>
    </button>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("flex gap-1 border-b border-cave-750", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
            value === t.id
              ? "border-torch-500 text-cave-100"
              : "border-transparent text-cave-400 hover:text-cave-200",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh] backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "fade-in relative w-full rounded-2xl border border-cave-700 bg-cave-850 shadow-2xl shadow-black/60",
          wide ? "max-w-4xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center justify-between border-b border-cave-750 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-cave-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-cave-400 hover:bg-cave-750 hover:text-cave-100"
          >
            <IconX />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-cave-750 px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-cave-400 hover:bg-cave-750 hover:text-cave-100",
        className,
      )}
      title="Copy"
    >
      {done ? <IconCheck size={14} className="text-emerald-400" /> : <IconCopy size={14} />}
      {label}
    </button>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-cave-700 px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-cave-500">{icon}</div> : null}
      <div className="text-sm font-medium text-cave-200">{title}</div>
      {children ? <div className="mt-1.5 max-w-md text-sm text-cave-400">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-rose-900/70 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function LimitBar({
  label,
  value,
  max,
  format,
  icon,
}: {
  label: string;
  value: number;
  max: number | null | undefined;
  format: (n: number) => string;
  icon?: ReactNode;
}) {
  const percent = max ? Math.min(100, (value / max) * 100) : null;
  return (
    <div
      className="min-w-0"
      title={max ? `${label}: ${format(value)} of ${format(max)}` : `${label}: ${format(value)}`}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {icon ? <span className="text-cave-500">{icon}</span> : null}
        <span className="font-mono tabular-nums text-cave-100">{format(value)}</span>
        {max ? <span className="font-mono tabular-nums text-cave-500">/ {format(max)}</span> : null}
      </div>
      {percent !== null ? (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-cave-750">
          <div
            className={cx(
              "h-full rounded-full transition-all",
              percent > 90 ? "bg-rose-500" : percent > 70 ? "bg-torch-500" : "bg-emerald-500/80",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-cave-100">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-cave-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

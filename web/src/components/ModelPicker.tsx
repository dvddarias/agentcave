import type { ModelInfo } from "@agentcave/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, errorText, keys } from "../lib/api";
import { formatTokens, perMillion } from "../lib/format";
import { IconBrain, IconChevronDown, IconEye, IconRefresh, IconSearch } from "./icons";
import { Button, cx, Modal, Pill, Spinner } from "./ui";

export function useModels() {
  return useQuery({ queryKey: keys.models, queryFn: () => api.models(), staleTime: 10 * 60_000 });
}

type Sort = "name" | "newest" | "price" | "context";

export function ModelPicker({
  value,
  onChange,
  allowEmpty,
  emptyLabel = "Agent default",
}: {
  value: string;
  onChange: (id: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const models = useModels();
  const current = models.data?.models.find((m) => m.id === value);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-cave-700 bg-cave-900 px-3 py-2 text-left text-sm hover:border-cave-600"
      >
        <span className="min-w-0">
          {value ? (
            <>
              <span className="block truncate text-cave-100">{current?.name ?? value}</span>
              <span className="block truncate font-mono text-[11px] text-cave-400">{value}</span>
            </>
          ) : (
            <span className="text-cave-400">{allowEmpty ? emptyLabel : "Choose a model…"}</span>
          )}
        </span>
        <IconChevronDown className="shrink-0 text-cave-400" />
      </button>
      <ModelPickerModal
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        allowEmpty={allowEmpty}
        emptyLabel={emptyLabel}
        onPick={(id) => {
          onChange(id);
          setOpen(false);
        }}
      />
    </>
  );
}

function ModelPickerModal({
  open,
  onClose,
  value,
  onPick,
  allowEmpty,
  emptyLabel,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onPick: (id: string) => void;
  allowEmpty?: boolean;
  emptyLabel: string;
}) {
  const models = useModels();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [onlyReasoning, setOnlyReasoning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let ms = (models.data?.models ?? []).filter((m) => {
      if (onlyReasoning && !m.supportsReasoning) return false;
      const hay = `${m.id} ${m.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const by: Record<Sort, (a: ModelInfo, b: ModelInfo) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      newest: (a, b) => b.created - a.created,
      price: (a, b) => a.pricing.prompt + a.pricing.completion - (b.pricing.prompt + b.pricing.completion),
      context: (a, b) => b.contextLength - a.contextLength,
    };
    ms = [...ms].sort(by[sort]);
    return ms;
  }, [models.data, q, sort, onlyReasoning]);

  return (
    <Modal open={open} onClose={onClose} title="Choose an OpenRouter model" wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <IconSearch className="absolute top-2.5 left-3 text-cave-500" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the search box is the purpose of this dialog
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models (e.g. claude sonnet, gpt, gemini flash)…"
            className="w-full rounded-lg border border-cave-700 bg-cave-900 py-2 pr-3 pl-9 text-sm text-cave-100 placeholder:text-cave-500 focus:border-torch-600 focus:outline-none"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="rounded-lg border border-cave-700 bg-cave-900 px-2 py-2 text-sm text-cave-200"
        >
          <option value="name">Name</option>
          <option value="newest">Newest</option>
          <option value="price">Cheapest</option>
          <option value="context">Biggest context</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-cave-300">
          <input
            type="checkbox"
            checked={onlyReasoning}
            onChange={(e) => setOnlyReasoning(e.target.checked)}
            className="accent-torch-500"
          />
          Reasoning only
        </label>
        <Button
          size="sm"
          variant="ghost"
          loading={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await api.models(true);
              await models.refetch();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          <IconRefresh size={14} /> Refresh
        </Button>
      </div>
      <p className="mb-2 text-[11px] text-cave-500">
        {models.data
          ? `${list.length} of ${models.data.models.length} models that support tool calling · prices per 1M tokens (in / out)`
          : null}
      </p>
      <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-cave-750">
        {models.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-cave-400">
            <Spinner /> Loading models from OpenRouter…
          </div>
        ) : models.error ? (
          <div className="p-6 text-sm text-rose-300">{errorText(models.error)}</div>
        ) : (
          <ul className="divide-y divide-cave-800">
            {allowEmpty ? (
              <li>
                <button
                  type="button"
                  onClick={() => onPick("")}
                  className="w-full px-3 py-2.5 text-left text-sm text-cave-300 hover:bg-cave-800"
                >
                  {emptyLabel}
                </button>
              </li>
            ) : null}
            {list.slice(0, 400).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onPick(m.id)}
                  className={cx(
                    "grid w-full grid-cols-[1fr_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-cave-800",
                    m.id === value && "bg-torch-500/10",
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-cave-100">{m.name}</span>
                      {m.supportsReasoning ? (
                        <Pill className="border-violet-800/60 text-violet-300" title="Supports reasoning">
                          <IconBrain size={11} /> reasoning
                        </Pill>
                      ) : null}
                      {m.supportsImages ? (
                        <Pill className="text-sky-300" title="Accepts images">
                          <IconEye size={11} /> vision
                        </Pill>
                      ) : null}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-cave-500">{m.id}</span>
                  </span>
                  <span className="text-right font-mono text-[11px] whitespace-nowrap text-cave-400">
                    <span className="block">
                      {perMillion(m.pricing.prompt)} / {perMillion(m.pricing.completion)}
                    </span>
                    <span className="block text-cave-500">{formatTokens(m.contextLength)} ctx</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

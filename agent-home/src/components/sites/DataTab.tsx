"use client";

import { useEffect, useState, type FormEvent } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { Sheet, inputClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useLocale, useT } from "@/i18n";
import type { SiteHistory, SiteTable, SiteTableRows } from "@/types/sites";

import { formatWhen, readJson, sitePath } from "./format";

const PAGE_SIZE = 50;
const META = new Set(["_key", "_first_seen", "_last_seen", "_removed_at"]);

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function rowsUrl(siteId: string, entity: string, q: string, page: number, includeRemoved: boolean): string {
  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
  if (q) params.set("q", q);
  if (includeRemoved) params.set("include_removed", "true");
  return `${sitePath(siteId, "tables", entity)}?${params}`;
}

export function exportUrl(siteId: string, entity: string, format: "csv" | "xlsx", includeRemoved: boolean): string {
  const params = new URLSearchParams({ format });
  if (includeRemoved) params.set("include_removed", "true");
  return `${sitePath(siteId, "tables", entity, "export")}?${params}`;
}

/** Data: one table per entity, searchable, with removed rows and row history on tap. */
export function DataTab({ siteId, tables }: { siteId: string; tables: SiteTable[] }) {
  const t = useT("sites");
  const [entity, setEntity] = useState(tables[0]?.name ?? "");
  const [draftQ, setDraftQ] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [result, setResult] = useState<{ url: string; data?: SiteTableRows; error?: string } | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const url = entity ? rowsUrl(siteId, entity, q, page, includeRemoved) : "";
  const loading = Boolean(url) && result?.url !== url;
  const data = result?.data && result.data.entity === entity ? result.data : null;
  const error = result?.url === url ? (result.error ?? null) : null;

  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url, { cache: "no-store" })
      .then((res) => readJson<SiteTableRows>(res))
      .then((doc) => live && setResult({ url, data: doc }))
      .catch((err: unknown) => live && setResult({ url, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [url]);

  if (tables.length === 0) {
    return (
      <div data-component="DataTab" className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-muted)]">
        {t("data.none")}
      </div>
    );
  }

  const table = tables.find((x) => x.name === entity);
  const columns = (data?.columns ?? []).filter((c) => c !== "_key");
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(draftQ.trim());
  }

  return (
    <div data-component="DataTab" className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("data.tables")}>
        {tables.map((x) => (
          <button
            key={x.name}
            type="button"
            role="tab"
            aria-selected={x.name === entity}
            onClick={() => {
              setEntity(x.name);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 font-mono text-xs ${
              x.name === entity
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-[var(--color-border)]"
            }`}
          >
            {x.name} <span className="opacity-70">{x.rows}</span>
          </button>
        ))}
      </div>
      {table ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <Pill tone={table.kind === "fixed" ? "accent" : "muted"}>{t(`kind.${table.kind}`)}</Pill>
          <span>{t("data.summary", { rows: table.rows, removed: table.removed })}</span>
          {table.last_seen ? <span>· {t("data.lastSeen", { when: formatWhen(table.last_seen) })}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={onSearch} className="flex min-w-0 flex-1 gap-2">
          <input
            type="search"
            aria-label={t("data.search")}
            placeholder={t("data.searchPlaceholder")}
            className={inputClass}
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
          />
          <button type="submit" className={secondaryButtonClass}>
            {t("data.filter")}
          </button>
        </form>
        {table?.kind === "variable" ? (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={includeRemoved}
              onChange={(e) => {
                setPage(1);
                setIncludeRemoved(e.target.checked);
              }}
            />
            {t("data.showRemoved")}
          </label>
        ) : null}
        <a className={secondaryButtonClass} href={exportUrl(siteId, entity, "csv", includeRemoved)} download>
          {t("data.exportCsv")}
        </a>
        <a className={secondaryButtonClass} href={exportUrl(siteId, entity, "xlsx", includeRemoved)} download>
          {t("data.exportXlsx")}
        </a>
      </div>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="relative overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        {loading ? (
          <div className="absolute right-3 top-3">
            <Spinner />
          </div>
        ) : null}
        <table className="w-full text-left text-xs">
          <thead className="text-[var(--color-muted)]">
            <tr>
              {columns.map((c) => (
                <th key={c} className={`whitespace-nowrap px-3 py-2 font-normal ${META.has(c) ? "italic" : ""}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((row) => {
              const key = cell(row._key);
              const removed = Boolean(row._removed_at);
              return (
                <tr
                  key={key}
                  data-removed={removed || undefined}
                  className={`cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)] ${removed ? "opacity-60 line-through" : ""}`}
                  onClick={() => setHistoryKey(key)}
                >
                  {columns.map((c) => (
                    <td key={c} className="max-w-[18rem] truncate whitespace-nowrap px-3 py-1.5">
                      {cell(row[c])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.rows.length === 0 ? (
          <p className="p-4 text-sm text-[var(--color-muted)]">{q ? t("data.noMatch") : t("data.empty")}</p>
        ) : null}
      </div>
      {data && data.total > data.page_size ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <button type="button" className={secondaryButtonClass} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("data.prev")}
          </button>
          <span>{t("data.page", { page, pages, total: data.total })}</span>
          <button type="button" className={secondaryButtonClass} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            {t("data.next")}
          </button>
        </div>
      ) : null}
      {historyKey !== null ? (
        <RowHistory siteId={siteId} entity={entity} rowKey={historyKey} onClose={() => setHistoryKey(null)} />
      ) : null}
    </div>
  );
}

function RowHistory({
  siteId,
  entity,
  rowKey,
  onClose,
}: {
  siteId: string;
  entity: string;
  rowKey: string;
  onClose(): void;
}) {
  const t = useT("sites");
  const locale = useLocale();
  const [doc, setDoc] = useState<SiteHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${sitePath(siteId, "history", entity)}/${encodeURIComponent(rowKey)}`, { cache: "no-store" })
      .then((res) => readJson<SiteHistory>(res))
      .then((d) => live && setDoc(d))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [siteId, entity, rowKey]);

  return (
    <Sheet title={t("history.title", { key: rowKey })} onClose={onClose} side component="SiteRowHistory">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {!doc && !error ? <Spinner /> : null}
      {doc ? (
        <div className="space-y-4 text-xs">
          {doc.versions.length ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("history.versions")}</h3>
              <ol className="space-y-2">
                {doc.versions.map((v, i) => (
                  <li key={i} className="rounded-lg border border-[var(--color-border)] p-2">
                    <div className="flex items-center gap-2">
                      <Pill tone={v.valid_to ? "muted" : "success"}>{t("history.version", { version: cell(v.version) })}</Pill>
                      <span className="text-[var(--color-muted)]">
                        {formatWhen(cell(v.valid_from), locale)}
                        {v.valid_to ? ` → ${formatWhen(cell(v.valid_to), locale)}` : ` · ${t("history.current")}`}
                      </span>
                    </div>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                      {JSON.stringify(v.payload, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("history.changes")}</h3>
            {doc.changes.length === 0 ? <p className="text-[var(--color-muted)]">{t("history.noChanges")}</p> : null}
            <ol className="space-y-2">
              {doc.changes.map((c, i) => (
                <li key={i} className="rounded-lg border border-[var(--color-border)] p-2">
                  <div className="flex items-center gap-2">
                    <Pill tone={c.op === "remove" ? "danger" : c.op === "insert" ? "success" : "accent"}>
                      {t(`history.op.${cell(c.op)}`)}
                    </Pill>
                    <span className="text-[var(--color-muted)]">{formatWhen(cell(c.at), locale)}</span>
                  </div>
                  <ChangeDiff before={c.before} after={c.after} />
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

/** Field-level before → after for one change (only the fields that moved). */
function ChangeDiff({ before, after }: { before: unknown; after: unknown }) {
  const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => cell(b[k]) !== cell(a[k]));
  if (keys.length === 0) return null;
  return (
    <table className="mt-1 w-full font-mono">
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <td className="pr-2 align-top text-[var(--color-muted)]">{k}</td>
            <td className="break-all align-top">
              {k in b ? <span className="text-red-400 line-through">{cell(b[k])}</span> : null}
              {k in b && k in a ? " → " : null}
              {k in a ? <span>{cell(a[k])}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

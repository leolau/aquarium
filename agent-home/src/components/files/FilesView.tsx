"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { BusyRegion } from "@/components/ui/BusyRegion";
import type {
  FileAsset,
  FileAssetsResponse,
  FileSurfacesResponse,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * The `/files` view: everything that arrived, from any surface, with where it
 * came from and whether anyone decided to remember it.
 *
 * This is not the memory page. A row here is a *record of arrival* — a file
 * appears the moment it lands, and its "Remembered" badge is the exception, not
 * the rule. Searching matches filename and sender, which is what a person
 * actually recalls about a file somebody sent them ("the PDF from Ada").
 *
 * The bytes are never linked directly: View/Download go through
 * `/api/files/:id/content`, which checks the caller and redirects to a
 * short-lived signed URL, so the bucket stays private and a copied link dies.
 */
export function FilesView({
  initial,
  surfaces,
}: {
  initial: FileAssetsResponse;
  surfaces: FileSurfacesResponse["surfaces"];
}) {
  const [files, setFiles] = useState<FileAsset[]>(initial.files);
  const [total, setTotal] = useState(initial.total);
  const [offset, setOffset] = useState(initial.offset);
  const limit = initial.limit;
  const [q, setQ] = useState("");
  const [surface, setSurface] = useState<string>("");
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileAsset | null>(null);

  const load = useCallback(
    async (opts: {
      query?: string;
      surface?: string;
      remembered?: boolean | null;
      offset?: number;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const sp = new URLSearchParams();
        const query = opts.query ?? q;
        const surf = opts.surface ?? surface;
        const rem = opts.remembered === undefined ? remembered : opts.remembered;
        if (query.trim()) sp.set("q", query.trim());
        if (surf) sp.set("surface", surf);
        if (rem != null) sp.set("remembered", String(rem));
        sp.set("limit", String(limit));
        sp.set("offset", String(opts.offset ?? 0));
        const res = await fetch(`/api/files?${sp.toString()}`);
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Your session expired — sign in again."
              : "Couldn't load your files.",
          );
          return;
        }
        const data: FileAssetsResponse = await res.json();
        setFiles(data.files);
        setTotal(data.total);
        setOffset(data.offset);
      } catch {
        setError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
      }
    },
    [limit, q, remembered, surface],
  );

  // The server already rendered the first page, so the debounce must not fire
  // on mount and refetch identical rows; it arms on the first keystroke.
  const armed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load({ query: q, offset: 0 }), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `load` changes with every filter; depending on it here would re-arm the
    // debounce on a chip click, which has already refetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div data-component="FilesView" className="flex flex-col gap-4">
      <Link
        href="/files/bridge"
        data-component="FolderBridgeAction"
        className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
      >
        <span>
          <span className="block font-medium">Folder Bridge</span>
          <span className="block text-xs text-[var(--color-muted)]">
            Connect local Mac folders for the agent to search and read
          </span>
        </span>
        <span aria-hidden className="text-[var(--color-muted)]">
          →
        </span>
      </Link>

      <div className="flex flex-col gap-3">
        <input
          data-component="FilesSearch"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by filename or sender"
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <div
          data-component="FilesFilters"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <Chip
            active={surface === ""}
            onClick={() => {
              setSurface("");
              void load({ surface: "", offset: 0 });
            }}
          >
            All sources
          </Chip>
          {surfaces.map((s) => (
            <Chip
              key={s.surface}
              active={surface === s.surface}
              onClick={() => {
                setSurface(s.surface);
                void load({ surface: s.surface, offset: 0 });
              }}
            >
              {surfaceLabel(s.surface)} · {s.count}
            </Chip>
          ))}
          <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
          <Chip
            active={remembered === true}
            onClick={() => {
              const next = remembered === true ? null : true;
              setRemembered(next);
              void load({ remembered: next, offset: 0 });
            }}
          >
            Remembered
          </Chip>
        </div>
      </div>

      {/* Only the results are covered while a query runs: search and the filter
       * chips stay live so the user can keep typing, but rows and the pager —
       * which would act on the list being replaced — don't take stray taps. */}
      <BusyRegion busy={loading} label="Loading your files…">
        <div className="flex flex-col gap-4">
          {error ? (
            <p
              data-component="FilesError"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
            >
              {error}
            </p>
          ) : files.length === 0 ? (
            <p
              data-component="FilesEmpty"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
            >
              {q || surface || remembered != null
                ? "No files match those filters."
                : "Nothing has arrived yet. Files sent in chat, Telegram, WhatsApp, email or a calendar invite land here automatically."}
            </p>
          ) : (
            <ul data-component="FilesList" className="flex flex-col gap-2">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(file)}
                    className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left transition hover:border-[var(--color-accent)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-sm font-medium">
                        {file.filename}
                      </span>
                      {file.remembered ? (
                        <span
                          data-component="RememberedBadge"
                          className="shrink-0 rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]"
                        >
                          Remembered
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {provenanceLine(file)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
            <span>
              {total} file{total === 1 ? "" : "s"}
            </span>
            <span className="flex items-center gap-2">
              <ActionButton busyLabel="Loading…"
                disabled={offset === 0 || loading}
                onAction={() => load({ offset: Math.max(0, offset - limit) })}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 disabled:opacity-40"
              >
                Newer
              </ActionButton>
              <span>
                {page} / {pages}
              </span>
              <ActionButton busyLabel="Loading…"
                disabled={offset + limit >= total || loading}
                onAction={() => load({ offset: offset + limit })}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 disabled:opacity-40"
              >
                Older
              </ActionButton>
            </span>
          </div>
        </div>
      </BusyRegion>

      {selected ? (
        <FileDetail file={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      data-component="Chip"
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

/** The provenance panel — where it came from, and how to open it. */
export function FileDetail({
  file,
  onClose,
}: {
  file: FileAsset;
  onClose: () => void;
}) {
  return (
    <div
      data-component="FileDetail"
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold break-all">{file.filename}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            ✕
          </button>
        </div>

        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="Arrived">{formatWhen(file.received_at)}</Row>
          <Row label="Source">{surfaceLabel(file.surface)}</Row>
          {file.sender_name || file.sender_id ? (
            <Row label="From">{file.sender_name || file.sender_id}</Row>
          ) : null}
          {file.conversation ? (
            <Row label="In">{file.conversation}</Row>
          ) : null}
          <Row label="Type">{file.content_type}</Row>
          <Row label="Size">{formatSize(file.byte_size)}</Row>
          <Row label="Memory">
            {file.remembered
              ? `Remembered${file.remembered_by ? ` by ${file.remembered_by}` : ""}`
              : "Stored only — not in memory"}
          </Row>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <a
            href={`/api/files/${encodeURIComponent(file.id)}/content`}
            target="_blank"
            rel="noopener"
            className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-[var(--color-accent)]"
          >
            View
          </a>
          <a
            href={`/api/files/${encodeURIComponent(file.id)}/content?download=1`}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
          >
            Download
          </a>
          {file.document_id ? (
            <a
              href={`/memory?document=${encodeURIComponent(file.document_id)}`}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
            >
              See what it remembers
            </a>
          ) : null}
          {file.inbound_item_id ? (
            <Link
              href={`/todos?source_ref=${encodeURIComponent(file.inbound_item_id)}&stage=staged,open,working,done,dismissed`}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
            >
              To-dos from this
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt data-component="Row" className="text-[var(--color-muted)]">{label}</dt>
      <dd className="break-all">{children}</dd>
    </>
  );
}

/** Human names for the surfaces; unknown ones are shown as sent. */
export function surfaceLabel(surface: string): string {
  const known: Record<string, string> = {
    agent_home: "Chat",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    email: "Email",
    calendar: "Calendar",
    imessage: "iMessage",
    discord: "Discord",
    slack: "Slack",
  };
  return known[surface] ?? surface;
}

/** "Telegram · Ada Wong · 6 Aug, 14:08" — the one line that identifies a file. */
export function provenanceLine(file: FileAsset): string {
  const parts = [surfaceLabel(file.surface)];
  if (file.sender_name || file.sender_id) {
    parts.push(String(file.sender_name || file.sender_id));
  }
  parts.push(formatWhen(file.received_at));
  parts.push(formatSize(file.byte_size));
  return parts.join(" · ");
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "unknown time";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "unknown time";
  return when.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

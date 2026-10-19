"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ResizableTable } from "@/components/get-ready/ResizableTable";
import { useLocale, useT } from "@/i18n";
import { htmlLang } from "@/i18n/config";
import { setPendingAttachments } from "@/lib/chat/pending-attachments";
import { importFile, listDirectoryEntries, resolveFile } from "@/lib/folder-bridge/fsOps";
import {
  fileSystemAccessSupported,
  getFolderHandle,
  reapproveFolder,
  restoreFolders,
} from "@/lib/folder-bridge/handles";
import type { FolderPermission } from "@/lib/folder-bridge/types";
import type { BrowseEntry, BrowsePlace, ChatAttachment } from "@/types";

/** A place on the left: a folder on this computer, a network folder or the workspace. */
export interface Place {
  key: string;
  source: "local" | "server";
  kind: "local" | "network" | "workspace";
  id: string;
  name: string;
  vpn?: string | null;
  shared?: boolean;
  trusted?: boolean;
  permission?: FolderPermission;
}

const TEXT_PREVIEW_MAX = 512 * 1024;
const TEXT_EXT = new Set(["txt", "md", "csv", "json", "log", "xml", "yaml", "yml", "ini", "html"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

type PreviewKind = "image" | "text" | "pdf" | "none";

export function previewKind(name: string): PreviewKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  if (ext === "pdf") return "pdf";
  return "none";
}

export function fileIcon(entry: Pick<BrowseEntry, "kind" | "name">): string {
  if (entry.kind === "directory") return "📁";
  const ext = entry.name.toLowerCase().split(".").pop() ?? "";
  if (IMAGE_EXT.has(ext)) return "🖼️";
  if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return "📊";
  if (TEXT_EXT.has(ext) || ["doc", "docx"].includes(ext)) return "📝";
  return "📄";
}

export function formatSize(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function serverFileUrl(place: string, path: string, download = false): string {
  const qs = new URLSearchParams({ place, path });
  if (download) qs.set("download", "1");
  return `/api/browse/file?${qs.toString()}`;
}

function sortEntries(entries: BrowseEntry[]): BrowseEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.kind !== "directory") - Number(b.kind !== "directory") ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

async function detailOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string } | null;
  return body?.detail || fallback;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function localFile(place: Place, path: string): Promise<File> {
  const handle = getFolderHandle(place.id);
  if (!handle) throw new Error("folder unavailable");
  return (await resolveFile(handle, path)).getFile();
}

type Preview =
  | { state: "loading" }
  | { state: "image"; url: string }
  | { state: "text"; text: string }
  | { state: "none" | "tooBig" };

/**
 * Files → Browse: click through folders, one level at a time, read-only.
 * Folders on this computer are listed by the browser (Folder Bridge handles);
 * network folders and the workspace go through `/api/browse/*`.
 */
export function BrowseView() {
  const t = useT("filesBrowse");
  const locale = useLocale();
  const router = useRouter();

  const [places, setPlaces] = useState<Place[]>([]);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [placesLoading, setPlacesLoading] = useState(true);
  const [localSupported, setLocalSupported] = useState(true);
  const [placeKey, setPlaceKey] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BrowseEntry | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [action, setAction] = useState<"save" | "ask" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const seq = useRef(0);

  const place = places.find((p) => p.key === placeKey) ?? null;
  const busy = opening !== null;

  useEffect(() => {
    let cancelled = false;
    const supported = fileSystemAccessSupported();
    void (async () => {
      const out: Place[] = [];
      if (supported) {
        const records = await restoreFolders().catch(() => []);
        for (const r of records) {
          out.push({
            key: `local:${r.id}`,
            source: "local",
            kind: "local",
            id: r.id,
            name: r.label,
            permission: r.permission,
          });
        }
      }
      try {
        const res = await fetch("/api/browse/places", { cache: "no-store" });
        if (!res.ok) throw new Error(await detailOf(res, `HTTP ${res.status}`));
        const body = (await res.json()) as { places: BrowsePlace[] };
        for (const p of body.places) {
          out.push({
            key: `server:${p.id}`,
            source: "server",
            kind: p.kind,
            id: p.id,
            name: p.kind === "workspace" ? t("workspaceName") : p.name,
            vpn: p.vpn,
            shared: p.shared,
            trusted: p.trusted_for_import,
          });
        }
      } catch (err) {
        if (!cancelled) setPlacesError(errText(err));
      }
      if (cancelled) return;
      setLocalSupported(supported);
      setPlaces(out);
      setPlacesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const blobUrl = useRef<string | null>(null);
  const previewSeq = useRef(0);

  const clearSelection = useCallback(() => {
    previewSeq.current += 1;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
    setSelected(null);
    setPreview(null);
    setLocalUrl(null);
  }, []);

  useEffect(
    () => () => {
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    },
    [],
  );

  const open = useCallback(
    async (target: Place, nextPath: string, openingKey: string) => {
      const mine = ++seq.current;
      setOpening(openingKey);
      setListError(null);
      try {
        let list: BrowseEntry[];
        let cut = false;
        if (target.source === "local") {
          const handle = getFolderHandle(target.id);
          if (!handle) throw new Error(t("local.gone"));
          const raw = await listDirectoryEntries(handle, nextPath);
          list = sortEntries(
            raw.map((e) => ({
              name: e.name,
              path: e.path,
              kind: e.kind,
              size: e.kind === "file" ? (e.size ?? null) : null,
              modified_at: e.modifiedAt ?? null,
            })),
          );
        } else {
          const qs = new URLSearchParams({ place: target.id, path: nextPath });
          const res = await fetch(`/api/browse/list?${qs.toString()}`, { cache: "no-store" });
          if (!res.ok) throw new Error(await detailOf(res, `HTTP ${res.status}`));
          const body = (await res.json()) as { entries: BrowseEntry[]; truncated: boolean };
          list = body.entries;
          cut = body.truncated;
        }
        if (mine !== seq.current) return;
        setPlaceKey(target.key);
        setPath(nextPath);
        setEntries(list);
        setTruncated(cut);
        clearSelection();
        setNotice(null);
      } catch (err) {
        if (mine !== seq.current) return;
        setPlaceKey(target.key);
        setListError(errText(err));
        setEntries([]);
        clearSelection();
      } finally {
        if (mine === seq.current) setOpening(null);
      }
    },
    [t, clearSelection],
  );

  function choosePlace(p: Place) {
    if (busy) return;
    setPath("");
    if (p.source === "local" && p.permission !== "granted") {
      setPlaceKey(p.key);
      setEntries([]);
      clearSelection();
      setListError(null);
      return;
    }
    void open(p, "", `place:${p.key}`);
  }

  async function reapprove(p: Place) {
    const permission = await reapproveFolder(p.id).catch(() => "denied" as const);
    setPlaces((all) => all.map((x) => (x.key === p.key ? { ...x, permission } : x)));
    if (permission === "granted") void open({ ...p, permission }, "", `place:${p.key}`);
  }


  async function select(p: Place, entry: BrowseEntry) {
    clearSelection();
    const mine = previewSeq.current;
    const kind = previewKind(entry.name);
    setSelected(entry);
    setNotice(null);
    setPreview({ state: "loading" });
    const show = (next: Preview) => {
      if (mine === previewSeq.current) setPreview(next);
    };
    try {
      if (p.source === "local") {
        const file = await localFile(p, entry.path);
        if (mine !== previewSeq.current) return;
        blobUrl.current = URL.createObjectURL(file);
        setLocalUrl(blobUrl.current);
        if (kind === "image") show({ state: "image", url: blobUrl.current });
        else if (kind === "text" && file.size <= TEXT_PREVIEW_MAX)
          show({ state: "text", text: await file.text() });
        else show({ state: kind === "text" ? "tooBig" : "none" });
        return;
      }
      const url = serverFileUrl(p.id, entry.path);
      if (kind === "image") show({ state: "image", url });
      else if (kind === "text" && (entry.size ?? 0) <= TEXT_PREVIEW_MAX) {
        const res = await fetch(url, { cache: "no-store" });
        show(res.ok ? { state: "text", text: await res.text() } : { state: "none" });
      } else show({ state: kind === "text" ? "tooBig" : "none" });
    } catch {
      show({ state: "none" });
    }
  }

  async function save(p: Place, entry: BrowseEntry) {
    if (action) return;
    if (
      p.kind === "network" &&
      !p.trusted &&
      !window.confirm(t("file.confirmUntrusted", { folder: p.name, name: entry.name }))
    ) {
      return;
    }
    setAction("save");
    setNotice(null);
    try {
      if (p.source === "local") {
        const handle = getFolderHandle(p.id);
        if (!handle) throw new Error(t("local.gone"));
        await importFile(handle, p.id, p.name, entry.path);
      } else {
        const res = await fetch("/api/browse/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ place: p.id, path: entry.path }),
        });
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; detail?: string }
          | null;
        if (!res.ok || !body?.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
      }
      setNotice({ ok: true, text: t("file.saved") });
    } catch (err) {
      setNotice({ ok: false, text: t("file.failed", { detail: errText(err) }) });
    } finally {
      setAction(null);
    }
  }

  async function ask(p: Place, entry: BrowseEntry) {
    if (action) return;
    setAction("ask");
    setNotice(null);
    try {
      let res: Response;
      if (p.source === "local") {
        const form = new FormData();
        form.set("file", await localFile(p, entry.path), entry.name);
        res = await fetch("/api/chat/upload", { method: "POST", body: form });
      } else {
        res = await fetch("/api/browse/attach", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ place: p.id, path: entry.path }),
        });
      }
      if (!res.ok) throw new Error(await detailOf(res, `HTTP ${res.status}`));
      const attachment = (await res.json()) as ChatAttachment;
      setPendingAttachments([attachment]);
      router.push(`/chat?draft=${encodeURIComponent(t("askDraft", { name: entry.name }))}`);
    } catch (err) {
      setNotice({ ok: false, text: t("file.failed", { detail: errText(err) }) });
      setAction(null);
    }
  }

  function enter(entry: BrowseEntry) {
    if (busy || !place) return;
    if (entry.kind === "directory") void open(place, entry.path, `entry:${entry.path}`);
    else void select(place, entry);
  }

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(htmlLang(locale), { dateStyle: "medium" }) : "—";

  const hint = (p: Place) =>
    p.kind === "local"
      ? t("hint.local")
      : p.kind === "workspace"
        ? t("hint.workspace")
        : p.shared
          ? t("hint.networkShared")
          : t("hint.network", { vpn: p.vpn ?? "" });

  const groups: { kind: Place["kind"]; label: string; icon: string }[] = [
    { kind: "local", label: t("places.local"), icon: "💻" },
    { kind: "network", label: t("places.network"), icon: "🗄️" },
    { kind: "workspace", label: t("places.workspace"), icon: "📁" },
  ];
  const iconOf = (p: Place) => groups.find((g) => g.kind === p.kind)?.icon ?? "📁";

  const crumbs = path ? path.split("/") : [];
  // A network folder can take seconds per level: say so above the list.
  const openingSelf =
    opening !== null && (!opening.startsWith("entry:") || place?.kind === "network");
  const slowHint = place?.kind === "network" ? t("openingSlow") : t("opening");

  return (
    <div
      data-component="BrowseView"
      className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)_300px]"
    >
      {/* Places: a sidebar on a computer, chips on a phone. */}
      <nav aria-label={t("places.label")} aria-busy={placesLoading} className="hidden md:block">
        {groups.map((g) => {
          const mine = places.filter((p) => p.kind === g.kind);
          return (
            <div key={g.kind} className="mb-3">
              <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
                {g.label}
              </div>
              {g.kind === "local" && !localSupported ? (
                <p className="px-2 text-xs text-[var(--color-muted)]">{t("local.unsupported")}</p>
              ) : mine.length === 0 && !placesLoading ? (
                <p className="px-2 text-xs text-[var(--color-muted)]">{t("places.none")}</p>
              ) : (
                mine.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    data-place={p.key}
                    disabled={busy}
                    aria-current={p.key === placeKey ? "true" : undefined}
                    onClick={() => choosePlace(p)}
                    className={`flex w-full items-start gap-2 rounded-lg p-2 text-left text-sm disabled:cursor-wait ${
                      p.key === placeKey
                        ? "bg-[var(--color-surface)] outline outline-1 outline-[var(--color-border)]"
                        : "hover:bg-[var(--color-surface)]"
                    }`}
                  >
                    <span aria-hidden>{iconOf(p)}</span>
                    <span className="min-w-0">
                      <span className="block truncate">{p.name}</span>
                      <span className="block text-[11px] text-[var(--color-muted)]">{hint(p)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          );
        })}
        {placesError ? (
          <p className="px-2 text-xs text-[var(--color-warn-text)]">
            {t("places.failed", { detail: placesError })}
          </p>
        ) : null}
      </nav>

      <div className="flex gap-2 overflow-x-auto md:hidden" aria-label={t("places.label")}>
        {places.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={busy}
            onClick={() => choosePlace(p)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs ${
              p.key === placeKey
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)]"
            }`}
          >
            <span aria-hidden>{iconOf(p)}</span> {p.name}
          </button>
        ))}
      </div>

      <section className="min-w-0" aria-busy={busy}>
        {!place ? (
          <p className="text-sm text-[var(--color-muted)]">
            {placesLoading ? t("opening") : t("choose")}
          </p>
        ) : place.source === "local" && place.permission !== "granted" ? (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
            <p className="mb-3">{t("local.needsPermission", { name: place.name })}</p>
            <button
              type="button"
              onClick={() => void reapprove(place)}
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[var(--color-accent-fg)]"
            >
              {t("local.reapprove")}
            </button>
          </div>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1 text-sm text-[var(--color-muted)]">
              <button
                type="button"
                disabled={busy}
                onClick={() => void open(place, "", `place:${place.key}`)}
                className="hover:text-[var(--color-text)]"
              >
                {place.name}
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span aria-hidden>/</span>
                  <button
                    type="button"
                    disabled={busy || i === crumbs.length - 1}
                    onClick={() => void open(place, crumbs.slice(0, i + 1).join("/"), `place:${place.key}`)}
                    className={i === crumbs.length - 1 ? "text-[var(--color-text)]" : "hover:text-[var(--color-text)]"}
                  >
                    {c}
                  </button>
                </span>
              ))}
              <span className="ml-2 rounded-full border border-[var(--color-border)] px-2 text-[11px]">
                {t("readOnly")}
              </span>
            </div>
            {openingSlow(openingSelf, slowHint)}
            {listError ? (
              <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-warn-text)]">
                {t("listFailed", { detail: listError })}
              </p>
            ) : entries.length === 0 && !busy ? (
              <p className="text-sm text-[var(--color-muted)]">{t("empty")}</p>
            ) : (
              <>
                <div className="hidden md:block">
                  <ResizableTable
                    label={t("table.label")}
                    columns={[t("col.name"), t("col.size"), t("col.modified")]}
                    initialWidths={[340, 100, 200]}
                  >
                    {entries.map((e) => (
                      <tr
                        key={e.path}
                        data-entry={e.path}
                        className={`border-t border-[var(--color-border)] ${
                          selected?.path === e.path ? "bg-[var(--color-accent)]/10" : ""
                        }`}
                      >
                        <td className="truncate px-3 py-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => enter(e)}
                            className="flex w-full min-w-0 items-center gap-2 text-left disabled:cursor-wait"
                          >
                            <span aria-hidden>{fileIcon(e)}</span>
                            <span className="truncate">{e.name}</span>
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--color-muted)]">
                          {formatSize(e.size)}
                        </td>
                        <td className="truncate px-3 py-2 text-[var(--color-muted)]">
                          {opening === `entry:${e.path}` ? (
                            <span className="text-[var(--color-warn-text)]">{t("opening")}</span>
                          ) : (
                            date(e.modified_at)
                          )}
                        </td>
                      </tr>
                    ))}
                  </ResizableTable>
                </div>
                <ul className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] md:hidden">
                  {entries.map((e) => (
                    <li key={e.path} className="border-b border-[var(--color-border)] last:border-b-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => enter(e)}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm ${
                          selected?.path === e.path ? "bg-[var(--color-accent)]/10" : ""
                        }`}
                      >
                        <span aria-hidden>{fileIcon(e)}</span>
                        <span className="min-w-0">
                          <span className="block truncate">{e.name}</span>
                          <span className="block text-[11px] text-[var(--color-muted)]">
                            {opening === `entry:${e.path}`
                              ? t("opening")
                              : e.kind === "file"
                                ? `${formatSize(e.size)} · ${date(e.modified_at)}`
                                : date(e.modified_at)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {truncated ? (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    {t("truncated", { count: entries.length })}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-[var(--color-muted)]">{t("oneLevel")}</p>
              </>
            )}
          </>
        )}
      </section>

      <aside
        data-component="BrowseFilePanel"
        className="min-w-0 md:col-start-2 lg:col-start-auto"
        aria-busy={action !== null}
      >
        {place && selected ? (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-all text-sm font-semibold">{selected.name}</div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  {formatSize(selected.size)} · {date(selected.modified_at)}
                </div>
              </div>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-[var(--color-muted)]"
              >
                {t("file.close")}
              </button>
            </div>
            <div className="mt-3">{renderPreview(preview, t)}</div>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                disabled={action !== null}
                onClick={() => void ask(place, selected)}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-accent-fg)] disabled:opacity-60"
              >
                {action === "ask" ? t("file.attaching") : t("file.ask")}
              </button>
              <button
                type="button"
                disabled={action !== null}
                onClick={() => void save(place, selected)}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
              >
                {action === "save" ? t("file.saving") : t("file.save")}
              </button>
              {fileLinks(place, selected, localUrl, t)}
            </div>
            {notice ? (
              <p
                role="status"
                className={`mt-3 text-xs ${notice.ok ? "text-emerald-400" : "text-[var(--color-warn-text)]"}`}
              >
                {notice.text}{" "}
                {notice.ok ? (
                  <Link href="/files" className="underline">
                    {t("file.savedLink")}
                  </Link>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : place && entries.length > 0 ? (
          <p className="hidden text-sm text-[var(--color-muted)] lg:block">{t("file.select")}</p>
        ) : null}
      </aside>
    </div>
  );
}

function openingSlow(show: boolean, text: string) {
  if (!show) return null;
  return (
    <p role="status" className="mb-2 text-xs text-[var(--color-warn-text)]">
      {text}
    </p>
  );
}

function renderPreview(preview: Preview | null, t: ReturnType<typeof useT>) {
  if (!preview) return null;
  if (preview.state === "loading")
    return <p className="text-xs text-[var(--color-muted)]">{t("file.loading")}</p>;
  if (preview.state === "image")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preview.url} alt="" className="max-h-72 w-full rounded-lg object-contain" />;
  if (preview.state === "text")
    return (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] p-2 text-xs">
        {preview.text}
      </pre>
    );
  return (
    <p className="text-xs text-[var(--color-muted)]">
      {preview.state === "tooBig" ? t("file.tooBig") : t("file.noPreview")}
    </p>
  );
}

function fileLinks(
  place: Place,
  entry: BrowseEntry,
  localUrl: string | null,
  t: ReturnType<typeof useT>,
) {
  const cls = "rounded-lg border border-[var(--color-border)] px-3 py-2 text-center text-sm";
  const openable = previewKind(entry.name) === "pdf";
  if (place.source === "local") {
    if (!localUrl) return null;
    return (
      <>
        {openable ? (
          <a href={localUrl} target="_blank" rel="noopener noreferrer" className={cls}>
            {t("file.open")}
          </a>
        ) : null}
        <a href={localUrl} download={entry.name} className={cls}>
          {t("file.download")}
        </a>
      </>
    );
  }
  return (
    <>
      {openable ? (
        <a
          href={serverFileUrl(place.id, entry.path)}
          target="_blank"
          rel="noopener noreferrer"
          className={cls}
        >
          {t("file.open")}
        </a>
      ) : null}
      <a href={serverFileUrl(place.id, entry.path, true)} className={cls}>
        {t("file.download")}
      </a>
    </>
  );
}

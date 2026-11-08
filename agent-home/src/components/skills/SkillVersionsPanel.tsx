"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { chipClass, toolButtonClass } from "@/components/skills/SkillPage";
import { skillHref } from "@/components/skills/skill-links";
import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { primaryButtonClass } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import {
  activeVersion,
  authorLabel,
  defaultPair,
  pairFor,
  parseUnifiedDiff,
  sortVersions,
  sourceLabel,
  timeAgo,
  type SkillVersionDiff,
  type SkillVersionList,
  type SkillVersionMeta,
} from "@/lib/skills/versions";

/** Uses and success rate of one version, from the usage ledger (C-1) when it is there. */
interface VersionUsage {
  version_id: string | null;
  uses: number;
  success_rate: number | null;
}

const draftChipClass =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2.5 py-px text-[11px] text-[var(--color-warn-text)]";
const activeChipClass =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2.5 py-px text-[11px] text-[var(--color-success)]";
const cardClass = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]";
const sectionLabel = "text-[11px] uppercase tracking-wide text-[var(--color-muted)]";
const selectClass =
  "!min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs outline-none focus:border-[var(--color-accent)]";

function StatusChip({ v }: { v: SkillVersionMeta }) {
  if (v.status === "draft") return <span className={draftChipClass}>Draft</span>;
  if (v.status === "active") return <span className={activeChipClass}>{v.trial_of ? "Active · trial" : "Active"}</span>;
  if (v.source === "baseline") return <span className={chipClass}>Baseline</span>;
  return null;
}

function percent(rate: number | null | undefined): string {
  return typeof rate === "number" ? `${Math.round(rate * 100)}%` : "no rated runs";
}

function usageLine(u: VersionUsage | undefined): string {
  if (!u) return "No recorded uses yet";
  const rate = typeof u.success_rate === "number" ? `, ${percent(u.success_rate)} success` : "";
  return `${u.uses} ${u.uses === 1 ? "use" : "uses"}${rate}`;
}

function byLine(v: SkillVersionMeta): string {
  const source = sourceLabel(v.source);
  return [authorLabel(v.author), source].filter(Boolean).join(" · ");
}

function statusText(v: SkillVersionMeta): string {
  if (v.status === "draft") return "Draft — not used by any chat yet";
  if (v.status === "active") return v.trial_of ? "Active on trial — new chats use it" : "Active — new chats use it";
  return "In history — not used by new chats";
}

/**
 * Versions tab on `/skills/[name]`: every saved version, a diff between any
 * two, and Try / Restore / Keep / Revert. Nothing is deleted; activating a
 * version copies it into the live skill for new chats.
 */
export function SkillVersionsPanel({ name, profile }: { name: string; profile: string }) {
  const router = useRouter();
  const q = profileQuery(profile);
  const scoped = useMemo(() => (q ? { profile } : {}), [q, profile]);
  const nameQ = `name=${encodeURIComponent(name)}${q ? `&${q}` : ""}`;

  const [list, setList] = useState<SkillVersionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [pairChoice, setPairChoice] = useState<[string, string] | null>(null);
  const [diff, setDiff] = useState<{ key: string; text?: string; error?: string } | null>(null);
  const [usage, setUsage] = useState<Record<string, VersionUsage>>({});
  const [confirm, setConfirm] = useState<SkillVersionMeta | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    getJson<SkillVersionList>(`/api/skills/versions?${nameQ}`)
      .then((d) => {
        if (!live) return;
        setList({ name: d.name || name, active: d.active ?? null, versions: d.versions ?? [] });
        setLoadError(null);
      })
      .catch((err) => live && setLoadError(errorText(err)));
    return () => {
      live = false;
    };
  }, [nameQ, name, attempt]);

  // Usage per version is a bonus: the tab works without the usage ledger.
  useEffect(() => {
    let live = true;
    getJson<{ by_version?: VersionUsage[] }>(`/api/skills/usage/detail?${nameQ}&limit=1`)
      .then((d) => {
        if (!live) return;
        const rows: Record<string, VersionUsage> = {};
        for (const r of d.by_version ?? []) if (r.version_id) rows[r.version_id] = r;
        setUsage(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [nameQ, attempt]);

  const versions = useMemo(() => (list ? sortVersions(list.versions) : []), [list]);
  const byId = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);
  const active = activeVersion(list);
  const pair = list ? (pairChoice ?? (picked ? pairFor(list, picked) : defaultPair(list))) : null;
  const selected = (picked ? byId.get(picked) : undefined) ?? (pair ? byId.get(pair[1]) : undefined) ?? active ?? versions[0] ?? null;
  const pairKey = pair ? `${pair[0]}..${pair[1]}` : "";

  useEffect(() => {
    if (!pair) return;
    let live = true;
    const key = `${pair[0]}..${pair[1]}`;
    getJson<SkillVersionDiff>(`/api/skills/versions/diff?${nameQ}&a=${encodeURIComponent(pair[0])}&b=${encodeURIComponent(pair[1])}`)
      .then((d) => live && setDiff({ key, text: d.diff ?? "" }))
      .catch((err) => live && setDiff({ key, error: errorText(err) }));
    return () => {
      live = false;
    };
    // pairKey identifies the pair; the array itself is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, nameQ]);

  async function activate(id: string, trial: boolean, done: string) {
    setNotice(null);
    try {
      const res = await sendJson<{ active: string | null; versions: SkillVersionMeta[] }>("/api/skills/versions/activate", "POST", {
        name,
        id,
        trial,
        ...scoped,
      });
      setList({ name, active: res.active ?? id, versions: res.versions ?? [] });
      setPicked(null);
      setPairChoice(null);
      setConfirm(null);
      setNotice({ tone: "success", text: done });
      // The Instructions tab and the header version chip read the live skill.
      router.refresh();
    } catch (err) {
      setConfirm(null);
      setNotice({ tone: "danger", text: errorText(err) });
    }
  }

  function pick(id: string) {
    setPicked(id);
    setPairChoice(null);
  }

  if (!list) {
    return loadError ? (
      <InlineAlert
        tone="danger"
        title="Version history couldn't be loaded."
        action={
          <button type="button" className={toolButtonClass} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        }
      >
        {loadError}
      </InlineAlert>
    ) : (
      <p role="status" data-component="SkillVersionsLoading" className="text-sm text-[var(--color-muted)]">
        Loading versions…
      </p>
    );
  }

  if (versions.length === 0) {
    return (
      <div data-component="SkillVersionsPanel" className="max-w-2xl">
        <p className="text-sm text-[var(--color-muted)]">
          No versions yet. The next save of this skill records it as v1, and every save after that adds a version you can go back to.
        </p>
      </div>
    );
  }

  const trialOf = active?.trial_of ? byId.get(active.trial_of) ?? null : null;
  const a = pair ? byId.get(pair[0]) ?? null : null;
  const b = pair ? byId.get(pair[1]) ?? null : null;
  const parsed = diff && diff.key === pairKey && diff.text !== undefined ? parseUnifiedDiff(diff.text) : null;
  const tag = (v: SkillVersionMeta | null) =>
    v ? `v${v.n}${v.status === "active" ? " (active)" : v.status === "draft" ? " (draft)" : ""}` : "";

  return (
    <div data-component="SkillVersionsPanel" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,320px)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        {active?.trial_of ? (
          <InlineAlert tone="warn" title={`Trying v${active.n}`}>
            <p>
              {usageLine(usage[active.id])}
              {trialOf ? ` (v${trialOf.n}: ${usage[trialOf.id] ? percent(usage[trialOf.id].success_rate) : "no data"})` : ""}. Keep it, or revert to{" "}
              {trialOf ? `v${trialOf.n}` : "the previous version"} for new chats.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <ActionButton className={primaryButtonClass} busyLabel="Keeping…" onAction={() => activate(active.id, false, `v${active.n} is now the active version.`)}>
                Keep v{active.n}
              </ActionButton>
              <ActionButton
                className={toolButtonClass}
                busyLabel="Reverting…"
                onAction={() => activate(active.trial_of as string, false, `Reverted to v${trialOf?.n ?? active.trial_of}.`)}
              >
                Revert to {trialOf ? `v${trialOf.n}` : active.trial_of}
              </ActionButton>
            </div>
          </InlineAlert>
        ) : null}

        {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}

        <section aria-label="Version history" className={`${cardClass} p-3`}>
          <h3 className={`${sectionLabel} mb-2`}>Version history</h3>
          <ul className="flex flex-col gap-2">
            {versions.map((v) => {
              const isSelected = selected?.id === v.id;
              return (
                <li
                  key={v.id}
                  data-version={v.id}
                  data-selected={isSelected || undefined}
                  className={`flex items-start gap-2 rounded-xl border p-3 ${
                    isSelected
                      ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <button type="button" aria-pressed={isSelected} onClick={() => pick(v.id)} className="min-w-0 flex-1 text-left">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <b className="text-sm">v{v.n}</b>
                      <StatusChip v={v} />
                    </span>
                    {v.message ? <span className="mt-1 block text-[13px] [overflow-wrap:anywhere]">{v.message}</span> : null}
                    <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                      {[byLine(v), timeAgo(v.created_at)].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                  {v.status === "draft" ? (
                    <ActionButton className={primaryButtonClass} busyLabel="Trying…" aria-label={`Try v${v.n}`} onAction={() => activate(v.id, true, `Trying v${v.n} for new chats.`)}>
                      Try
                    </ActionButton>
                  ) : v.status !== "active" ? (
                    <button type="button" className={toolButtonClass} aria-label={`Restore v${v.n}`} onClick={() => setConfirm(v)}>
                      Restore
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{a && b ? `Compare ${tag(a)} → ${tag(b)}` : "Compare versions"}</h3>
            {parsed ? (
              <p className="text-xs text-[var(--color-muted)]">
                +{parsed.added} −{parsed.removed} lines
                {parsed.files.length === 1 ? ` in ${parsed.files[0]}` : parsed.files.length > 1 ? ` in ${parsed.files.length} files` : ""}
              </p>
            ) : null}
          </div>
          {b?.status === "draft" ? (
            <>
              <Link href={skillHref(name, profile, "edit", `draft=${encodeURIComponent(b.id)}`)} className={`${toolButtonClass} inline-flex items-center`}>
                ✎ Edit draft
              </Link>
              <ActionButton className={primaryButtonClass} busyLabel="Trying…" onAction={() => activate(b.id, true, `Trying v${b.n} for new chats.`)}>
                Try v{b.n}
              </ActionButton>
            </>
          ) : b && b.status !== "active" ? (
            <button type="button" className={toolButtonClass} onClick={() => setConfirm(b)}>
              Restore v{b.n}
            </button>
          ) : null}
        </div>

        {versions.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
            <label className="flex items-center gap-1.5">
              From
              <select
                className={selectClass}
                value={pair?.[0] ?? ""}
                onChange={(e) => setPairChoice([e.target.value, pair?.[1] ?? versions[0].id])}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {tag(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              To
              <select
                className={selectClass}
                value={pair?.[1] ?? ""}
                onChange={(e) => {
                  setPicked(e.target.value);
                  setPairChoice([pair?.[0] ?? active?.id ?? versions[0].id, e.target.value]);
                }}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {tag(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div data-component="SkillVersionDiff" className={`${cardClass} overflow-hidden`}>
          {!pair ? (
            <p className="p-3.5 text-sm text-[var(--color-muted)]">Only one version so far — there is nothing to compare yet.</p>
          ) : pair[0] === pair[1] ? (
            <p className="p-3.5 text-sm text-[var(--color-muted)]">Pick two different versions to compare.</p>
          ) : diff?.key === pairKey && diff.error ? (
            <p role="alert" className="p-3.5 text-sm text-[var(--color-danger)]">
              The diff couldn&apos;t be loaded: {diff.error}
            </p>
          ) : !parsed ? (
            <p role="status" className="p-3.5 text-sm text-[var(--color-muted)]">
              Loading diff…
            </p>
          ) : parsed.rows.length === 0 ? (
            <p className="p-3.5 text-sm text-[var(--color-muted)]">These versions are identical.</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto bg-[var(--color-surface-2)] py-1.5 font-mono text-[12.5px] leading-relaxed">
              {parsed.rows.map((r, k) =>
                r.kind === "file" || r.kind === "hunk" || r.kind === "note" ? (
                  <div key={k} data-row={r.kind} className="px-3 py-0.5 text-[var(--color-muted)]">
                    {r.kind === "file" ? r.text : r.kind === "hunk" ? `⋯ ${r.text}` : r.text}
                  </div>
                ) : (
                  <div
                    key={k}
                    data-op={r.kind}
                    className={`grid grid-cols-[3.25rem_1rem_minmax(0,1fr)] ${
                      r.kind === "add"
                        ? "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)]"
                        : r.kind === "del"
                          ? "bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
                          : ""
                    }`}
                  >
                    <span className="select-none pr-2 text-right text-[var(--color-muted)]">{r.newNo ?? r.oldNo}</span>
                    <span
                      aria-hidden
                      className={`select-none ${r.kind === "add" ? "text-[var(--color-success)]" : r.kind === "del" ? "text-[var(--color-danger)]" : ""}`}
                    >
                      {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                    </span>
                    <span className="whitespace-pre-wrap pr-3 [overflow-wrap:anywhere]">{r.text}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {selected ? (
          <section aria-label={`About v${selected.n}`} className={`${cardClass} p-3.5`}>
            <h3 className={`${sectionLabel} mb-1`}>About v{selected.n}</h3>
            <dl className="grid grid-cols-1 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)] [&_dd]:border-b [&_dd]:border-[var(--color-border)] [&_dd]:pb-2 [&_dd]:pt-0.5 sm:[&_dd]:py-2 [&_dt]:pt-2 [&_dt]:text-[var(--color-muted)] sm:[&_dt]:border-b sm:[&_dt]:border-[var(--color-border)] sm:[&_dt]:pb-2">
              <dt>Created by</dt>
              <dd>
                {byLine(selected)}
                {selected.message ? ` — “${selected.message}”` : ""}
              </dd>
              <dt>Based on</dt>
              <dd>
                {selected.parent
                  ? `${byId.get(selected.parent) ? tag(byId.get(selected.parent) ?? null) : selected.parent}`
                  : "— (first version)"}
              </dd>
              <dt>Saved</dt>
              <dd>{timeAgo(selected.created_at) || "—"}</dd>
              <dt>Evidence</dt>
              <dd>{usageLine(usage[selected.id])}</dd>
              <dt>Status</dt>
              <dd>{statusText(selected)}</dd>
            </dl>
          </section>
        ) : null}
      </div>

      {confirm ? (
        <ConfirmDialog
          title={`Restore v${confirm.n}?`}
          body={`v${confirm.n} becomes the active version for new chats. Other versions stay in history, so you can switch back at any time.`}
          confirmLabel={`Restore v${confirm.n}`}
          onConfirm={() => activate(confirm.id, false, `v${confirm.n} is now the active version.`)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

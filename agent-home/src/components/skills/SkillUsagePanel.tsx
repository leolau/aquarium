"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type MouseEvent } from "react";

import { relativeTime } from "@/components/landing/chats/model";
import { accentChipClass, chipClass, toolButtonClass } from "@/components/skills/SkillPage";
import { ActionButton } from "@/components/ui/ActionButton";
import { FolderIcon, MessageIcon, PlayIcon, PlusIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import {
  applyRating,
  canRate,
  eventKind,
  fillTrend,
  matchesFilter,
  percent,
  USAGE_WINDOWS,
  versionLabel,
  type SkillUsageDetail,
  type SkillUsageEvent,
  type SkillUsageRow,
  type UsageFilter,
  type UsageOutcome,
  type UsageWindow,
} from "@/lib/skills/usage";

/** Other skill tabs this one links to. */
export type UsageLinkTab = "versions" | "improve";

const PAGE = 50;

const TRIGGER_LABEL: Record<string, string> = {
  skill_view: "loaded by the agent",
  slash: "slash command",
  preload: "preloaded",
  cron: "scheduled job",
  bundle: "skill bundle",
};

const OUTCOME_PILL: Record<UsageOutcome | "none", { label: string; className: string }> = {
  success: { label: "Success", className: "border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-success)]" },
  partial: { label: "Partial", className: "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-warn-text)]" },
  failure: { label: "Failed", className: "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-danger)]" },
  none: { label: "Not rated", className: "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]" },
};

const cardClass = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5";
const eyebrowClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";

interface Loaded {
  key: string;
  data?: SkillUsageDetail;
  error?: string;
}

/**
 * The skill page's Usage tab: how often the skill ran in the window, which
 * chats, kanban tasks and projects used it, which version they ran and what
 * came of it. Kanban runs report their own result; chat runs are rated here.
 */
export function SkillUsagePanel({
  name,
  profile,
  tabHref,
  onOpenTab,
}: {
  name: string;
  profile: string;
  /** Deep link to another tab of this skill (`?tab=`). */
  tabHref: (tab: UsageLinkTab) => string;
  /** Switch tabs in place; returning false (or no handler) lets the link navigate. */
  onOpenTab?: (tab: UsageLinkTab) => boolean;
}) {
  const [days, setDays] = useState<UsageWindow>(90);
  const [reloads, setReloads] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [filter, setFilter] = useState<UsageFilter>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [ratedHere, setRatedHere] = useState<Set<number>>(() => new Set());
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");

  const q = profileQuery(profile);
  const base = `name=${encodeURIComponent(name)}${q ? `&${q}` : ""}`;
  const key = `${base}&days=${days}#${reloads}`;

  useEffect(() => {
    let live = true;
    getJson<SkillUsageDetail>(`/api/skills/usage/detail?${base}&days=${days}&limit=${PAGE}`)
      .then((data) => live && setLoaded({ key, data }))
      .catch((err) => live && setLoaded({ key, error: errorText(err) }));
    return () => {
      live = false;
    };
  }, [base, days, key]);

  // The active version comes from the version history; it only colours the chart.
  useEffect(() => {
    let live = true;
    getJson<{ active?: string | null }>(`/api/skills/versions?${base}`)
      .then((v) => live && setActiveVersion(typeof v.active === "string" ? v.active : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base]);

  const current = loaded && loaded.key === key ? loaded : null;
  const data = current?.data ?? null;
  const events = useMemo(() => data?.events ?? [], [data]);
  const active = activeVersion ?? events.find((e) => e.version_id)?.version_id ?? null;

  const patch = (fn: (d: SkillUsageDetail) => SkillUsageDetail) =>
    setLoaded((l) => (l && l.key === key && l.data ? { ...l, data: fn(l.data) } : l));

  const older = async () => {
    if (!data?.next_cursor) return;
    setMessage(null);
    try {
      const more = await getJson<SkillUsageDetail>(
        `/api/skills/usage/detail?${base}&days=${days}&limit=${PAGE}&cursor=${encodeURIComponent(data.next_cursor)}`,
      );
      patch((d) => ({ ...d, events: [...d.events, ...more.events.filter((e) => !d.events.some((x) => x.id === e.id))], next_cursor: more.next_cursor }));
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const rate = async (event: SkillUsageEvent, rating: 1 | -1, note?: string) => {
    setMessage(null);
    try {
      const updated = await sendJson<SkillUsageEvent>("/api/skills/usage/feedback", "POST", {
        event_id: event.id,
        rating,
        ...(note?.trim() ? { note: note.trim() } : {}),
        ...(q ? { profile } : {}),
      });
      const after: SkillUsageEvent = { ...event, ...updated, id: event.id };
      setRatedHere((s) => new Set(s).add(event.id));
      setNoteFor(null);
      setNoteText("");
      patch((d) => ({
        ...d,
        summary: applyRating(d.summary, event, after),
        events: d.events.map((e) => (e.id === event.id ? after : e)),
      }));
      // Per-version rates can't be recomputed locally (the server sends rates,
      // not counts), so reload them from the ledger.
      getJson<SkillUsageDetail>(`/api/skills/usage/detail?${base}&days=${days}&limit=1`)
        .then((fresh) => patch((d) => ({ ...d, by_version: fresh.by_version })))
        .catch(() => undefined);
    } catch (err) {
      setMessage(errorText(err));
    }
  };

  const tabLink = (tab: UsageLinkTab) => ({
    href: tabHref(tab),
    onClick: (e: MouseEvent) => {
      if (onOpenTab?.(tab)) e.preventDefault();
    },
  });

  const windowPicker = (
    <div role="group" aria-label="Time window" className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5">
      {USAGE_WINDOWS.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={days === d}
          onClick={() => setDays(d)}
          className={`min-h-8 rounded-full px-3 text-xs ${days === d ? "bg-[var(--color-bg)] font-medium text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
        >
          {d} days
        </button>
      ))}
    </div>
  );

  if (!current) {
    return (
      <div data-component="SkillUsagePanel" data-state="loading" aria-busy="true" className="space-y-3">
        <div className="flex justify-end">{windowPicker}</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`${cardClass} h-[68px] animate-pulse`} />
          ))}
        </div>
        <div className={`${cardClass} h-40 animate-pulse`} />
        <p className="sr-only" role="status">
          Loading usage…
        </p>
      </div>
    );
  }

  if (current.error || !data) {
    return (
      <div data-component="SkillUsagePanel" data-state="error" className="max-w-2xl space-y-3">
        <InlineAlert
          tone="danger"
          title="Usage couldn't be loaded"
          action={
            <button type="button" className={toolButtonClass} onClick={() => setReloads((n) => n + 1)}>
              Try again
            </button>
          }
        >
          {current.error}
        </InlineAlert>
      </div>
    );
  }

  const s = data.summary;
  const rateText = percent(s.success_rate);
  const lastUsed = s.last_used_at ? relativeTime(s.last_used_at) : null;
  const negativeNotes = events.filter((e) => e.rating === -1).length;
  const more = Boolean(data.next_cursor);
  const visible = events.filter((e) => matchesFilter(e, filter));
  const count = (f: UsageFilter): string => {
    if (f === "all") return String(s.uses);
    if (f === "failed") return String(s.failure);
    if (f === "unrated") return String(s.unknown);
    const n = events.filter((e) => matchesFilter(e, f)).length;
    return more ? `${n}+` : String(n);
  };

  const tiles: Array<[string, string]> = [
    [String(s.uses), `uses in the last ${days} days`],
    [rateText ?? "—", rateText ? "success rate (rated + kanban runs)" : "no results yet"],
    [`${s.sessions} · ${s.tasks} · ${s.projects}`, "chats · tasks · projects"],
    [lastUsed ?? "Never", "last used"],
  ];

  const filterChip = (f: UsageFilter, label: string, tone = "") => (
    <button
      key={f}
      type="button"
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
      className={`inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-xs ${
        filter === f
          ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]"
          : tone || "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"
      }`}
    >
      {label} <span className="opacity-80">{count(f)}</span>
    </button>
  );

  return (
    <div data-component="SkillUsagePanel" data-state={s.uses ? "ready" : "empty"} className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm text-[var(--color-muted)]">Every chat, kanban task and project run that loaded {name}, and what came of it.</p>
          {windowPicker}
        </div>

        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map(([value, label]) => (
            <div key={label} data-component="StatTile" className={`${cardClass} flex flex-col-reverse`}>
              <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
              <dd className="text-lg font-semibold [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>

        {message ? <InlineAlert tone="danger">{message}</InlineAlert> : null}

        {s.uses === 0 ? (
          <div className={`${cardClass} p-6 text-center`}>
            <p className="font-medium">No runs in the last {days} days</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              When a chat, kanban task or scheduled job loads this skill, the run shows up here with its result.
            </p>
          </div>
        ) : (
          <>
            <UsesChart trend={s.trend} days={days} events={events} active={active} />

            <section aria-label="Runs that used this skill" className={cardClass}>
              <h3 className={eyebrowClass}>Runs that used this skill</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filterChip("all", "All")}
                {filterChip("chats", "Chats")}
                {filterChip("tasks", "Kanban tasks")}
                {filterChip("projects", "Projects")}
                {filterChip("failed", "Failed", "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-danger)]")}
                {filterChip("unrated", "Not rated", "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-warn-text)]")}
              </div>
              <ul className="mt-3 space-y-2">
                {visible.map((e) => (
                  <RunRow
                    key={e.id}
                    event={e}
                    active={active}
                    ratedHere={ratedHere.has(e.id)}
                    noteOpen={noteFor === e.id}
                    noteText={noteText}
                    onNoteText={setNoteText}
                    onOpenNote={() => {
                      setNoteFor(e.id);
                      setNoteText("");
                    }}
                    onCloseNote={() => setNoteFor(null)}
                    onRate={(rating, note) => rate(e, rating, note)}
                  />
                ))}
                {visible.length === 0 ? (
                  <li className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-center text-sm text-[var(--color-muted)]">
                    {more ? "None of the loaded runs match. Load older runs to look further back." : "No runs match this filter."}
                  </li>
                ) : null}
              </ul>
              {more ? (
                <ActionButton className="mt-2 min-h-11 px-2 text-sm text-[var(--color-accent)]" busyLabel="Loading…" onAction={older}>
                  Show older runs
                </ActionButton>
              ) : null}
            </section>
          </>
        )}
      </div>

      <aside aria-label="Usage by version" className="flex flex-col gap-3">
        <div className={cardClass}>
          <h3 className={eyebrowClass}>By version</h3>
          {data.by_version.length ? (
            <ul className="mt-2 space-y-2.5">
              {data.by_version.map((v) => {
                const isActive = v.version_id !== null && v.version_id === active;
                const pct = percent(v.success_rate);
                return (
                  <li key={v.version_id ?? "none"} data-version={v.version_id ?? ""}>
                    <div className="flex items-baseline gap-2 text-[13px]">
                      <span className={`flex-1 ${isActive ? "font-medium" : ""}`}>
                        {versionLabel(v.version_id)}
                        {isActive ? " · active" : ""}
                      </span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {v.uses} {v.uses === 1 ? "use" : "uses"}
                        {pct ? ` · ${pct} success` : ""}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]" aria-hidden>
                      <div
                        className={`h-full rounded-full ${isActive ? "bg-[var(--color-success)]" : "bg-[var(--color-muted)]"}`}
                        style={{ width: `${Math.round((v.success_rate ?? 0) * 100)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-muted)]">No runs to compare yet.</p>
          )}
          <a {...tabLink("versions")} className={`${toolButtonClass} mt-3 inline-flex items-center`}>
            Compare versions
          </a>
        </div>

        <InlineAlert tone="info">
          Kanban runs report their result automatically. Chat uses count once someone marks them Helpful or Not helpful.
        </InlineAlert>

        {s.failure > 0 || negativeNotes > 0 ? (
          <div data-component="NeedsWork" className={cardClass}>
            <h3 className={eyebrowClass}>Needs work?</h3>
            <p className="mt-1.5 text-sm text-[var(--color-muted)]">
              {needsWorkText(s, negativeNotes, days)} Ask the agent to review them and draft a new version.
            </p>
            <a
              {...tabLink("improve")}
              className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3.5 text-xs font-medium text-[var(--color-accent-fg)]"
            >
              <PlusIcon size={14} />
              Improve with the agent
            </a>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function needsWorkText(s: SkillUsageRow, notes: number, days: number): string {
  const parts = [
    s.failure ? `${s.failure} failed ${s.failure === 1 ? "run" : "runs"}` : "",
    notes ? `${notes} "not helpful" ${notes === 1 ? "note" : "notes"}` : "",
  ].filter(Boolean);
  return `${parts.join(" and ")} in the last ${days} days.`;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Uses per day; days since the active version's first run are highlighted. */
function UsesChart({
  trend,
  days,
  events,
  active,
}: {
  trend: SkillUsageRow["trend"];
  days: number;
  events: SkillUsageEvent[];
  active: string | null;
}) {
  const series = useMemo(() => fillTrend(trend, days), [trend, days]);
  const max = Math.max(1, ...series.map((d) => d.uses));
  const since = useMemo(() => {
    const first = events.filter((e) => active && e.version_id === active).reduce((m, e) => Math.min(m, e.ts), Infinity);
    return Number.isFinite(first) ? new Date(first * 1000).toISOString().slice(0, 10) : null;
  }, [events, active]);
  const total = series.reduce((n, d) => n + d.uses, 0);
  return (
    <section aria-label="Uses per day" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
      <h3 className={eyebrowClass}>Uses per day · {days} days</h3>
      <div role="img" aria-label={`${total} uses over ${days} days, at most ${max} in a day`} className="mt-3 flex h-24 items-end gap-px sm:gap-0.5">
        {series.map((d) => {
          const current = since !== null && d.day >= since;
          return (
            <div
              key={d.day}
              data-day={d.day}
              data-active={current || undefined}
              title={`${dayLabel(d.day)}: ${d.uses} ${d.uses === 1 ? "use" : "uses"}`}
              className={`min-w-0 flex-1 rounded-t-sm ${current ? "bg-[var(--color-accent)]" : "bg-[var(--color-muted)]/60"}`}
              style={{ height: d.uses ? `${Math.max(6, (d.uses / max) * 100)}%` : "2px" }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        {since && active ? (
          <span className="inline-flex items-center gap-1.5 text-[var(--color-accent)]">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-[var(--color-accent)]" />
            {active} (active) · since {dayLabel(since)}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-[var(--color-muted)]/60" />
          {since && active ? "earlier versions" : "uses"}
        </span>
      </div>
    </section>
  );
}

function runTitle(e: SkillUsageEvent): string {
  const kind = eventKind(e);
  if (kind === "task") return `Task · ${e.task?.title || "Untitled task"}`;
  if (kind === "project") return `Project · ${e.project?.name || e.project?.slug}`;
  return `Chat · “${e.session?.title || "Untitled chat"}”`;
}

function runHref(e: SkillUsageEvent): string | null {
  const kind = eventKind(e);
  if (kind === "task" && e.task && e.project) {
    return `/projects/${encodeURIComponent(e.project.slug)}/cards/${encodeURIComponent(e.task.id)}`;
  }
  if (kind === "project" && e.project) return `/projects/${encodeURIComponent(e.project.slug)}`;
  if (e.session) return `/chat?session=${encodeURIComponent(e.session.id)}`;
  return null;
}

function sourceText(e: SkillUsageEvent, ratedHere: boolean): string {
  if (e.outcome_source === "kanban") return "from kanban run";
  if (e.outcome_source === "user") return ratedHere ? "rated by you" : "rated by a person";
  if (e.outcome_source === "auto") return "detected automatically";
  return "";
}

function RunRow({
  event: e,
  active,
  ratedHere,
  noteOpen,
  noteText,
  onNoteText,
  onOpenNote,
  onCloseNote,
  onRate,
}: {
  event: SkillUsageEvent;
  active: string | null;
  ratedHere: boolean;
  noteOpen: boolean;
  noteText: string;
  onNoteText(text: string): void;
  onOpenNote(): void;
  onCloseNote(): void;
  onRate(rating: 1 | -1, note?: string): Promise<void>;
}) {
  const kind = eventKind(e);
  const Icon = kind === "task" ? PlayIcon : kind === "project" ? FolderIcon : MessageIcon;
  const href = runHref(e);
  const title = runTitle(e);
  const meta = [
    kind !== "project" && e.project ? `Project: ${e.project.name || e.project.slug}` : "",
    e.user_id ?? "",
    TRIGGER_LABEL[e.trigger] ?? e.trigger,
    relativeTime(e.ts),
  ].filter(Boolean);
  const pill = OUTCOME_PILL[e.outcome ?? "none"];
  const source = sourceText(e, ratedHere);
  const rateable = canRate(e);
  return (
    <li data-component="UsageRun" data-run={e.id} data-kind={kind} className="rounded-xl border border-[var(--color-border)] px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Icon size={18} className="mt-0.5 text-[var(--color-muted)]" />
          <div className="min-w-0 flex-1">
            {href ? (
              <Link href={href} className="text-sm font-medium [overflow-wrap:anywhere] hover:text-[var(--color-accent)]">
                {title}
              </Link>
            ) : (
              <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
            )}
            <p className="text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">{meta.join(" · ")}</p>
            {e.note ? <p className="mt-1 text-xs italic text-[var(--color-muted)] [overflow-wrap:anywhere]">“{e.note}”</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-7 sm:pl-0">
          <span className={e.version_id && e.version_id === active ? accentChipClass : chipClass}>{versionLabel(e.version_id)}</span>
          <span data-outcome={e.outcome ?? "none"} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-px text-[11px] ${pill.className}`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {pill.label}
          </span>
          {source ? <span className="text-xs text-[var(--color-muted)]">{source}</span> : null}
          {rateable && !noteOpen ? (
            <>
              <ActionButton className={toolButtonClass} busyLabel="Saving…" onAction={() => onRate(1)} aria-label={`Helpful: ${title}`}>
                Helpful
              </ActionButton>
              <button type="button" className={`${toolButtonClass} border-transparent bg-transparent text-[var(--color-muted)]`} onClick={onOpenNote} aria-label={`Not helpful: ${title}`}>
                Not helpful
              </button>
            </>
          ) : null}
        </div>
      </div>
      {rateable && noteOpen ? (
        <div className="mt-2 space-y-2 pl-7">
          <label className="block text-xs text-[var(--color-muted)]">
            What went wrong? (optional, helps when improving the skill)
            <textarea
              value={noteText}
              onChange={(ev) => onNoteText(ev.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm text-[var(--color-fg)]"
            />
          </label>
          <div className="flex gap-2">
            <ActionButton className={toolButtonClass} busyLabel="Saving…" onAction={() => onRate(-1, noteText)}>
              Mark not helpful
            </ActionButton>
            <button type="button" className={`${toolButtonClass} border-transparent bg-transparent`} onClick={onCloseNote}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Skills-list usefulness hint: "12 uses · 92% success", or "unused in 90 days". */
export function SkillUsageSignal({ row, days }: { row: SkillUsageRow | undefined; days: number }) {
  if (!row || row.uses === 0) {
    return (
      <span data-component="SkillUsageSignal" data-unused className="text-xs text-[var(--color-muted)]">
        unused in {days} days
      </span>
    );
  }
  const pct = percent(row.success_rate);
  return (
    <span data-component="SkillUsageSignal" className="text-xs text-[var(--color-muted)]">
      {row.uses} {row.uses === 1 ? "use" : "uses"}
      {pct ? ` · ${pct} success` : ""}
    </span>
  );
}

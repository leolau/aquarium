"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { OCEAN_GRADIENT } from "@/components/aquarium/AquariumBackdrop";
import { NewProfileDialog } from "@/components/profiles/NewProfileDialog";
import {
  Avatar,
  Metric,
  Skel,
  Spark,
  StatusPill,
} from "@/components/profiles/card-atoms";
import {
  FILTER_LABEL,
  SORT_LABEL,
  activityLine,
  activityShort,
  channelLabels,
  compactNumber,
  costLabel,
  creatureLabel,
  matchesSearch,
  profileCreature,
  profileStatus,
  sortProfiles,
  type ProfileSort,
  type ProfileStatus,
  type StatusFilter,
} from "@/components/profiles/profile-cards";
import { RefBadge } from "@/components/refs/RefBadge";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import {
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import {
  BellIcon,
  ChevronRightIcon,
  ClockIcon,
  CoinsIcon,
  FolderIcon,
  InfoIcon,
  LoaderIcon,
  MessageIcon,
  SearchIcon,
  SparklesIcon,
} from "@/components/ui/icons";
import { errorText, getJson } from "@/lib/admin-fetch";
import type {
  ModelProviderOption,
  ProfileInfo,
  ProfileStats,
  ProfileStatsResponse,
} from "@/types";

export interface ProfilesViewProps {
  initialProfiles: ProfileInfo[];
  providers: ModelProviderOption[];
  error: string | null;
}

const STATS_DAYS = 30;
const FILTERS: StatusFilter[] = ["all", "working", "ready", "off", "setup"];

type StatsState =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; data: ProfileStatsResponse };

/** The Profiles page body: summary strip, toolbar, profile cards (rows on a phone) and new-profile dialog. */
export function ProfilesView({
  initialProfiles,
  providers,
  error,
}: ProfilesViewProps) {
  const router = useRouter();
  const [profiles, setProfiles] = useState(initialProfiles);
  const [loadError, setLoadError] = useState(error);
  const [stats, setStats] = useState<StatsState>({ state: "loading" });
  const [opening, setOpening] = useState<string | null>(null);
  const openLock = useRef(false);
  const [creating, setCreating] = useState<{ from?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<ProfileSort>("active");

  const fetchStats = useCallback(
    () =>
      getJson<ProfileStatsResponse>(
        `/api/profiles/stats?days=${STATS_DAYS}`,
      ).then(
        (data): StatsState => ({ state: "ready", data }),
        (err): StatsState => ({ state: "error", error: errorText(err) }),
      ),
    [],
  );

  const loadStats = useCallback(async () => {
    setStats({ state: "loading" });
    setStats(await fetchStats());
  }, [fetchStats]);

  useEffect(() => {
    let live = true;
    void fetchStats().then((next) => {
      if (live) setStats(next);
    });
    return () => {
      live = false;
    };
  }, [fetchStats]);

  const reload = useCallback(async () => {
    try {
      const data = await getJson<{ profiles: ProfileInfo[] }>("/api/profiles");
      setProfiles(data.profiles);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  /** One tap navigates to the profile page; later taps are ignored until it loads. */
  const open = useCallback(
    (name: string) => {
      if (openLock.current) return;
      openLock.current = true;
      setOpening(name);
      router.push(`/profiles/${encodeURIComponent(name)}`);
    },
    [router],
  );

  const statsMap = stats.state === "ready" ? stats.data.profiles : null;
  const statusOf = useCallback(
    (p: ProfileInfo) => profileStatus(p, statsMap?.[p.name]),
    [statsMap],
  );

  const counts = useMemo(() => {
    const out: Record<StatusFilter, number> = {
      all: profiles.length,
      working: 0,
      ready: 0,
      off: 0,
      setup: 0,
    };
    for (const p of profiles) out[statusOf(p)] += 1;
    return out;
  }, [profiles, statusOf]);

  const visible = useMemo(
    () =>
      sortProfiles(
        profiles.filter(
          (p) =>
            (filter === "all" || statusOf(p) === filter) &&
            matchesSearch(p, statsMap?.[p.name], query),
        ),
        statsMap,
        sort,
      ),
    [profiles, filter, statusOf, statsMap, query, sort],
  );

  return (
    <section data-component="ProfilesView" className="space-y-4">
      <SummaryStrip count={profiles.length} stats={stats} />

      {stats.state === "error" ? (
        <InlineAlert
          tone="danger"
          title="Couldn't load activity numbers"
          action={
            <ActionButton
              className={secondaryButtonClass}
              busyLabel="Retrying…"
              onAction={loadStats}
              data-appmcp-hint="Reloads the activity numbers for every profile"
            >
              Retry
            </ActionButton>
          }
        >
          Profiles still open as usual; tokens, skills used and projects show
          “—” until this works ({stats.error}).
        </InlineAlert>
      ) : null}

      <div
        data-component="ProfilesToolbar"
        className="flex flex-wrap items-center gap-2 lg:gap-3"
      >
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 sm:max-w-xs">
          <SearchIcon
            size={14}
            className="shrink-0 text-[var(--color-muted)]"
          />
          <input
            type="search"
            aria-label="Search profiles"
            placeholder="Search name, goal or skill"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-muted)]"
          />
        </label>
        <button
          type="button"
          data-testid="new-profile"
          className={`${primaryButtonClass} sm:order-last`}
          onClick={() => setCreating({})}
        >
          + New profile
        </button>
        <div className="-mx-1 w-full overflow-x-auto px-1 lg:w-auto">
          <div
            role="group"
            aria-label="Filter by status"
            className="inline-flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
          >
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                data-filter={f}
                data-appmcp-hint={`Shows only ${f} profiles`}
                onClick={() => setFilter(f)}
                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs ${
                  filter === f
                    ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                }`}
              >
                {FILTER_LABEL[f]}
                <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] text-[var(--color-fg)]">
                  {counts[f]}
                </span>
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm lg:ml-auto">
          <span className="text-[var(--color-muted)]">Sort:</span>
          <select
            aria-label="Sort profiles"
            value={sort}
            onChange={(e) => setSort(e.target.value as ProfileSort)}
            className="bg-transparent font-medium outline-none"
          >
            {(Object.keys(SORT_LABEL) as ProfileSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadError ? (
        <InlineAlert tone="danger" title="Couldn't load profiles">
          {loadError}
        </InlineAlert>
      ) : null}

      {visible.length === 0 && profiles.length > 0 ? (
        <p
          data-component="ProfilesEmpty"
          className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]"
        >
          No profile matches{query ? ` “${query}”` : ""}
          {filter !== "all" ? ` in ${FILTER_LABEL[filter]}` : ""}.
        </p>
      ) : null}

      <ul
        data-component="ProfileGrid"
        className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4"
      >
        {visible.map((p) => (
          <li key={p.name} className="min-w-0">
            <ProfileCard
              profile={p}
              stats={stats}
              status={statusOf(p)}
              opening={opening === p.name}
              locked={opening !== null}
              onOpen={() => open(p.name)}
            />
            <ProfileRow
              profile={p}
              stats={stats}
              status={statusOf(p)}
              opening={opening === p.name}
              locked={opening !== null}
              onOpen={() => open(p.name)}
            />
          </li>
        ))}
      </ul>

      <p className="flex items-start gap-1.5 text-xs text-[var(--color-muted)]">
        <InfoIcon size={14} className="mt-px shrink-0" />
        <span>
          Numbers cover the last {STATS_DAYS} days. Open a card to edit its
          goal, model, creature and skills. Pending{" "}
          <Link
            href="/profiles/suggestions"
            className="text-[var(--color-accent)] underline"
          >
            Profile suggestions
          </Link>{" "}
          stay on their own page; adopting one adds a card here.
        </span>
      </p>

      {creating ? (
        <NewProfileDialog
          profiles={profiles}
          providers={providers}
          initialSource={creating.from}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            setCreating(null);
            await reload();
            void loadStats();
          }}
        />
      ) : null}
    </section>
  );
}

/** An inline skeleton bone (the stats load after the page renders). */
function SummaryStrip({ count, stats }: { count: number; stats: StatsState }) {
  const t = stats.state === "ready" ? stats.data.totals : null;
  const value = (v: string | undefined) =>
    stats.state === "loading" ? (
      <Skel className="h-7 w-12 bg-white/20" />
    ) : (
      (v ?? "—")
    );
  const kpis: Array<[ReactNode, string]> = [
    [String(count), count === 1 ? "profile" : "profiles"],
    [value(t ? String(t.working) : undefined), "running now"],
    [value(t ? String(t.needs_you) : undefined), "need you"],
    [
      value(t ? compactNumber(t.tokens) : undefined),
      `tokens · ${STATS_DAYS} days`,
    ],
    [
      value(t ? String(t.projects_done) : undefined),
      `projects done · ${STATS_DAYS} days`,
    ],
    [
      value(t ? (t.cost_usd > 0 ? costLabel(t.cost_usd) : "$0") : undefined),
      `model cost · ${STATS_DAYS} days`,
    ],
  ];
  return (
    <div
      data-component="ProfilesSummary"
      aria-busy={stats.state === "loading"}
      className={`relative -mx-1 overflow-x-auto rounded-2xl px-1 sm:mx-0 sm:px-0 ${OCEAN_GRADIENT}`}
    >
      <dl className="relative flex gap-2 p-2 sm:flex-wrap sm:items-center sm:justify-around sm:gap-x-8 sm:gap-y-3 sm:px-8 sm:py-4">
        {kpis.map(([v, label]) => (
          <div
            key={label}
            className="shrink-0 rounded-xl bg-white/10 px-3 py-2 sm:bg-transparent sm:p-0"
          >
            <dd className="text-lg font-bold text-white sm:text-2xl">{v}</dd>
            <dt className="whitespace-nowrap text-xs text-white/80">{label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface ItemProps {
  profile: ProfileInfo;
  stats: StatsState;
  status: ProfileStatus;
  opening: boolean;
  locked: boolean;
  onOpen(): void;
}

function ProfileCard({
  profile: p,
  stats,
  status,
  opening,
  locked,
  onOpen,
}: ItemProps) {
  const s: ProfileStats | undefined =
    stats.state === "ready" ? stats.data.profiles[p.name] : undefined;
  const loading = stats.state === "loading";
  const failed = stats.state === "error";
  const creature = profileCreature(p);
  const never = !loading && !failed && !s?.last_active_at && !s?.current_task;
  const dash = (v: string) =>
    loading ? <Skel className="h-5 w-12" /> : failed || never ? "—" : v;
  const used = s?.skills_used ?? 0;
  const channels = channelLabels(s);
  const activity = loading
    ? null
    : failed
      ? "Activity unavailable"
      : activityLine(s);
  return (
    <article
      data-component="ProfileCard"
      data-status={status}
      aria-busy={opening}
      className={`relative hidden h-full flex-col gap-3 rounded-2xl border bg-[var(--color-surface)] p-4 transition-colors focus-within:border-[var(--color-accent)] hover:border-[var(--color-accent)] sm:flex ${
        status === "setup"
          ? "border-[var(--color-warn)]/50"
          : "border-[var(--color-border)]"
      }`}
    >
      <button
        type="button"
        data-profile={p.name}
        aria-label={`Open ${p.name}`}
        disabled={locked}
        onClick={onOpen}
        className="absolute inset-0 rounded-2xl disabled:cursor-progress"
      />
      <div className="flex items-center gap-3">
        <Avatar profile={p} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold">{p.name}</span>
            <RefBadge value={p.ref} className="relative z-10" />
            {p.is_default ? <Pill tone="accent">default</Pill> : null}
          </div>
          <p className="truncate text-xs text-[var(--color-muted)]">
            {creatureLabel(creature)} · {p.model || "no model"}
          </p>
          <div className="mt-1">
            <StatusPill status={status} />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Goal
        </p>
        <p className="line-clamp-2 min-h-[2.25rem] text-[13px] leading-[18px]">
          {p.description || (
            <span className="text-[var(--color-muted)]">
              No goal written yet.
            </span>
          )}
        </p>
        <div className="flex min-h-5 items-center gap-1.5 text-xs">
          {activity === null ? (
            <Skel className="h-3.5 w-32" />
          ) : (
            <>
              {s?.current_task ? (
                <LoaderIcon
                  size={12}
                  className="shrink-0 text-[var(--color-accent)]"
                />
              ) : (
                <ClockIcon
                  size={12}
                  className="shrink-0 text-[var(--color-muted)]"
                />
              )}
              <span
                data-component="ProfileActivity"
                className={`min-w-0 truncate ${s?.current_task ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-muted)]"}`}
              >
                {activity}
              </span>
            </>
          )}
          {s?.needs_you ? (
            <span className="shrink-0">
              <Pill tone="warning">{s.needs_you} need you</Pill>
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric
          icon={<CoinsIcon size={12} />}
          label={`Tokens · ${STATS_DAYS}d`}
          tip={`Tokens sent to and from the model in the last ${STATS_DAYS} days, all chats and projects. The bars are the last 7 days.`}
          value={dash(compactNumber(s?.tokens ?? 0))}
          sub={
            loading
              ? "…"
              : failed
                ? "—"
                : never
                  ? "no usage yet"
                  : costLabel(s?.cost_usd ?? 0)
          }
          extra={s && !never ? <Spark values={s.tokens_by_day} /> : undefined}
        />
        <Metric
          icon={<SparklesIcon size={12} />}
          label="Skills used"
          tip={`Different skills this profile used in the last ${STATS_DAYS} days, out of the skills installed on it.`}
          value={
            loading ? (
              <Skel className="h-5 w-12" />
            ) : (
              `${failed ? "—" : used} / ${p.skill_count}`
            )
          }
          sub="used / installed"
        />
        <Metric
          icon={<FolderIcon size={12} />}
          label="Projects"
          tip={`Projects this profile finished a run on in the last ${STATS_DAYS} days, and projects it is running now.`}
          value={dash(String(s?.projects_done ?? 0))}
          sub={
            loading
              ? "…"
              : failed
                ? "—"
                : s?.projects_running
                  ? `${s.projects_running} running`
                  : never
                    ? "no projects yet"
                    : "none running"
          }
        />
        <Metric
          icon={<MessageIcon size={12} />}
          label={`Chats · ${STATS_DAYS}d`}
          tip={`Conversations started with this profile in the last ${STATS_DAYS} days, on every channel.`}
          value={dash(String(s?.chats ?? 0))}
          sub={
            loading
              ? "…"
              : failed
                ? "—"
                : never || !s
                  ? "none yet"
                  : `across ${s.chat_sources.length} channel${s.chat_sources.length === 1 ? "" : "s"}`
          }
        />
      </div>

      <div className="space-y-1.5">
        <div
          role="progressbar"
          aria-label="Skills used"
          aria-valuemin={0}
          aria-valuemax={p.skill_count}
          aria-valuenow={Math.min(used, p.skill_count)}
          className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        >
          <div
            className="h-full rounded-full bg-[var(--color-accent)]"
            style={{
              width: `${p.skill_count ? Math.min(100, (used / p.skill_count) * 100) : 0}%`,
            }}
          />
        </div>
        {s?.top_skills.length ? (
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px]">
            <span className="text-[var(--color-muted)]">Top:</span>
            {s.top_skills.map((k) => (
              <span
                key={k.name}
                className="truncate rounded-full bg-[var(--color-surface-2)] px-2 py-0.5"
              >
                {k.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {status === "setup" ? (
        <InlineAlert
          tone="warn"
          className="relative z-10"
          action={
            <button
              type="button"
              disabled={locked}
              onClick={onOpen}
              className={`${primaryButtonClass} inline-flex items-center gap-1.5`}
            >
              {opening ? <Spinner /> : null}
              Set model
            </button>
          }
        >
          No model set, so this profile can’t run yet.
        </InlineAlert>
      ) : null}

      <div className="mt-auto flex items-center gap-2 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-muted)]">
        <BellIcon size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {channels.length ? channels.join(" · ") : "No channels"}
        </span>
        <span className="flex items-center gap-0.5 text-xs font-semibold text-[var(--color-accent)]">
          {opening ? <Spinner /> : null}
          {opening ? "Opening…" : "Open"}
          <ChevronRightIcon size={14} />
        </span>
      </div>
    </article>
  );
}

function ProfileRow({
  profile: p,
  stats,
  status,
  opening,
  locked,
  onOpen,
}: ItemProps) {
  const s = stats.state === "ready" ? stats.data.profiles[p.name] : undefined;
  const loading = stats.state === "loading";
  const failed = stats.state === "error";
  const never = !loading && !failed && !s?.last_active_at && !s?.current_task;
  const show = (v: string) => (loading ? "…" : failed || never ? "—" : v);
  const metrics: Array<[ReactNode, string, string]> = [
    [
      <CoinsIcon key="t" size={11} />,
      show(compactNumber(s?.tokens ?? 0)),
      "tokens",
    ],
    [
      <SparklesIcon key="s" size={11} />,
      `${loading ? "…" : failed ? "—" : (s?.skills_used ?? 0)}/${p.skill_count}`,
      "skills used / installed",
    ],
    [
      <FolderIcon key="p" size={11} />,
      show(String(s?.projects_done ?? 0)),
      "projects done",
    ],
    [
      <ClockIcon key="c" size={11} />,
      loading ? "…" : failed ? "—" : activityShort(s),
      "last active",
    ],
  ];
  return (
    <button
      type="button"
      data-component="ProfileRow"
      data-profile-row={p.name}
      data-status={status}
      aria-label={`Open ${p.name}`}
      aria-busy={opening}
      disabled={locked}
      onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-[14px] border bg-[var(--color-surface)] p-3 text-left disabled:cursor-progress sm:hidden ${
        status === "setup"
          ? "border-[var(--color-warn)]/50"
          : "border-[var(--color-border)]"
      }`}
    >
      <Avatar profile={p} size={44} />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{p.name}</span>
          {p.ref ? (
            <span data-ref={p.ref} className="shrink-0 font-mono text-[11px] text-[var(--color-muted)]">
              {p.ref}
            </span>
          ) : null}
          {p.is_default ? <Pill tone="accent">default</Pill> : null}
          <span className="ml-auto shrink-0">
            <StatusPill status={status} needs={s?.needs_you} />
          </span>
        </span>
        <span className="block truncate text-xs text-[var(--color-muted)]">
          {p.description || "No goal written yet."}
        </span>
        <span className="flex items-center gap-2.5 text-[11px] text-[var(--color-muted)]">
          {metrics.map(([icon, v, label]) => (
            <span
              key={label}
              title={label}
              className={`inline-flex items-center gap-0.5 ${label === "last active" && s?.current_task ? "text-[var(--color-accent)]" : ""}`}
            >
              {icon}
              <span className="sr-only">{label}: </span>
              {v}
            </span>
          ))}
        </span>
      </span>
      {opening ? (
        <Spinner className="text-[var(--color-accent)]" />
      ) : (
        <ChevronRightIcon
          size={16}
          className="shrink-0 text-[var(--color-muted)]"
        />
      )}
    </button>
  );
}

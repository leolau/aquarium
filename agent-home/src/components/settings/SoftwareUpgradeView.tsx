"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { ActionButton } from "@/components/ui/ActionButton";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import { useHydrated } from "@/lib/use-hydrated";
import type {
  SoftwareUpgradeJob,
  SoftwareUpgradeRelease,
  SoftwareUpgradeStatus,
  SoftwareUpgradeStep,
} from "@/types";

const POLL_MS = 3000;
const CARD = "mb-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const CHIP = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px]";
const CHIP_OK = `${CHIP} border-green-200 bg-green-50 text-green-700`;
const CHIP_BAD = `${CHIP} border-red-200 bg-red-50 text-red-700`;
const CHIP_ACCENT = `${CHIP} border-[var(--color-accent)] text-[var(--color-accent)]`;
const CHIP_MUTED = `${CHIP} border-[var(--color-border)] text-[var(--color-muted)]`;
const BTN = "min-h-11 rounded-full border border-[var(--color-border)] px-4 text-sm disabled:opacity-50";
const BTN_PRIMARY = "min-h-11 rounded-full bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50";

function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** "4 m 37 s" between two ISO stamps (no clock involved, so safe to render on the server). */
export function tookLabel(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${String(s % 60).padStart(2, "0")} s`;
}

function between(a: string | null, b: string | null): number | null {
  const x = epoch(a);
  const y = epoch(b);
  return x == null || y == null ? null : y - x;
}

type Confirm = { kind: "upgrade" | "rollback"; tag: string } | null;

export function SoftwareUpgradeView({ initial }: { initial: SoftwareUpgradeStatus }) {
  const t = useT("upgrade");
  const [status, setStatus] = useState<SoftwareUpgradeStatus>(initial);
  const [selected, setSelected] = useState<string | null>(initial.releases?.latest ?? null);
  const [expanded, setExpanded] = useState<string | null>(initial.releases?.latest ?? null);
  const [showOlder, setShowOlder] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [watching, setWatching] = useState<string | null>(initial.job?.running ? initial.job.id : null);

  const job = status.job ?? null;
  const running = Boolean(job?.running);
  const canUpgrade = Boolean(status.can_upgrade);

  const reload = useCallback(async () => {
    const res = await fetch("/api/software-upgrade", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const next = (await res.json()) as SoftwareUpgradeStatus;
    setStatus(next);
    setSelected((cur) =>
      cur && [...(next.releases?.newer ?? []), ...(next.releases?.older ?? [])].some((r) => r.tag === cur)
        ? cur
        : (next.releases?.latest ?? null),
    );
  }, []);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch("/api/software-upgrade/job", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as SoftwareUpgradeStatus;
        if (stopped) return;
        setReconnecting(false);
        if (!next.available) return;
        setStatus((cur) => ({ ...cur, ...next, releases: cur.releases, release_error: cur.release_error }));
        if (!next.job?.running) await reload().catch(() => undefined);
      } catch {
        if (!stopped) setReconnecting(true);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [running, reload]);

  const checkNow = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch("/api/software-upgrade/check", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as SoftwareUpgradeStatus & { detail?: string };
      if (!res.ok) throw new Error(body.detail ?? String(res.status));
      setStatus(body);
      if (body.release_error) setCheckError(body.release_error);
      setSelected((cur) => cur ?? body.releases?.latest ?? null);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const started = (next: SoftwareUpgradeStatus) => {
    setStatus((cur) => ({ ...cur, ...next, releases: cur.releases, can_upgrade: cur.can_upgrade }));
    setWatching(next.job?.id ?? null);
    setConfirm(null);
  };

  if (!status.available) {
    return (
      <div data-component="SoftwareUpgradeView" className={CARD}>
        <p className="text-sm text-[var(--color-muted)]">{t("unavailable", { detail: status.error ?? "" })}</p>
      </div>
    );
  }

  const showJob = job && (running || job.id === watching);
  return (
    <div data-component="SoftwareUpgradeView">
      {!canUpgrade ? (
        <p data-testid="upgrade-read-only" className="mb-4 rounded-xl bg-[var(--color-surface)] p-3 text-xs text-[var(--color-muted)]">
          {t("readOnly")}
        </p>
      ) : null}
      {showJob ? (
        <JobPanel
          job={job}
          reconnecting={reconnecting}
          canUpgrade={canUpgrade}
          rollbackTo={status.rollback_to ?? null}
          onRollback={(tag) => setConfirm({ kind: "rollback", tag })}
          onClose={() => setWatching(null)}
        />
      ) : (
        <>
          <InstalledCard status={status} checking={checking} checkError={checkError} onCheck={checkNow} />
          <ReleasePicker
            status={status}
            selected={selected}
            expanded={expanded}
            showOlder={showOlder}
            canUpgrade={canUpgrade}
            onSelect={(tag) => {
              setSelected(tag);
              setExpanded((cur) => (cur === tag ? null : tag));
            }}
            onShowOlder={setShowOlder}
            onUpgrade={(tag) => setConfirm({ kind: "upgrade", tag })}
          />
          <HistoryCard status={status} />
        </>
      )}
      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          older={Boolean(status.releases?.older.some((r) => r.tag === confirm.tag))}
          onCancel={() => setConfirm(null)}
          onStarted={started}
        />
      ) : null}
    </div>
  );
}

/* ── installed release ─────────────────────────────────────────────── */

function InstalledCard({
  status,
  checking,
  checkError,
  onCheck,
}: {
  status: SoftwareUpgradeStatus;
  checking: boolean;
  checkError: string | null;
  onCheck: () => Promise<void>;
}) {
  const t = useT("upgrade");
  const time = useTimeLabel();
  const inst = status.installed;
  const installedAt = epoch(inst?.installed_at);
  const checked = epoch(status.checked_at);
  return (
    <section data-section="installed" className={CARD}>
      <h2 className="text-sm font-semibold">{t("installed")}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{t("release")}</dt>
          <dd className="font-semibold" data-testid="installed-version">{inst?.label}</dd>
          {inst?.kind === "checkout" ? (
            <dd className="text-xs text-[var(--color-muted)]">{t("checkoutHint")}</dd>
          ) : null}
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{t("installedWhen")}</dt>
          <dd className="font-semibold">{installedAt == null ? t("unknown") : time(installedAt, "ago")}</dd>
          {installedAt != null ? (
            <dd className="text-xs text-[var(--color-muted)]">
              {inst?.by
                ? t("byOn", { by: inst.by, date: time(installedAt, "dateTime") })
                : t("on", { date: time(installedAt, "dateTime") })}
            </dd>
          ) : null}
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{t("channel")}</dt>
          <dd className="font-semibold">{inst?.channel === "beta" ? t("channelBeta") : t("channelStable")}</dd>
          <dd className="text-xs text-[var(--color-muted)]">
            {inst?.channel === "beta" ? t("channelBetaHint") : t("channelStableHint")}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{t("lastCheck")}</dt>
          <dd>
            <span className="font-semibold">{checked == null ? t("never") : time(checked, "ago")}</span>{" "}
            <ActionButton
              onAction={onCheck}
              busy={checking}
              busyLabel={t("checking")}
              className="text-xs text-[var(--color-accent)] disabled:opacity-50"
              data-testid="upgrade-check-now"
            >
              {t("checkNow")}
            </ActionButton>
          </dd>
          {checkError ? (
            <dd className="text-xs text-[var(--color-danger)]">{t("checkFailed", { detail: checkError })}</dd>
          ) : null}
        </div>
      </dl>
    </section>
  );
}

/* ── choose a release ──────────────────────────────────────────────── */

function ReleasePicker({
  status,
  selected,
  expanded,
  showOlder,
  canUpgrade,
  onSelect,
  onShowOlder,
  onUpgrade,
}: {
  status: SoftwareUpgradeStatus;
  selected: string | null;
  expanded: string | null;
  showOlder: boolean;
  canUpgrade: boolean;
  onSelect: (tag: string) => void;
  onShowOlder: (on: boolean) => void;
  onUpgrade: (tag: string) => void;
}) {
  const t = useT("upgrade");
  const time = useTimeLabel();
  const newer = status.releases?.newer ?? [];
  const older = status.releases?.older ?? [];
  const latest = newer.find((r) => r.tag === status.releases?.latest);
  const isOlder = older.some((r) => r.tag === selected);
  const installed = status.installed?.version;
  return (
    <>
      <div
        data-testid="upgrade-banner"
        className="mb-4 rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-fg)]"
      >
        {newer.length ? (
          <>
            <b>{newer.length === 1 ? t("newerOne") : t("newerMany", { count: newer.length })}</b>{" "}
            {latest ? t("latestIs", { tag: latest.tag, date: time(epoch(latest.published_at), "date") }) : null}
          </>
        ) : (
          <b>{t("upToDate")}</b>
        )}
      </div>
      <section data-section="choose-release" className={CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{t("choose")}</h2>
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={showOlder}
              onChange={(e) => onShowOlder(e.target.checked)}
              data-testid="upgrade-show-older"
            />
            {t("showOlder")}
          </label>
        </div>
        <p className="mb-3 mt-1 text-xs text-[var(--color-muted)]">{t("chooseHint")}</p>
        {newer.map((rel) => (
          <ReleaseRow
            key={rel.tag}
            rel={rel}
            selected={selected === rel.tag}
            open={expanded === rel.tag}
            latest={rel.tag === status.releases?.latest}
            onSelect={() => onSelect(rel.tag)}
          />
        ))}
        {showOlder ? (
          <div data-testid="upgrade-older">
            {installed ? (
              <div className="mb-2 flex items-center gap-3 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm">
                <input type="radio" disabled aria-label={installed} />
                <b>{installed}</b>
                <span className={CHIP_OK}>{t("installedChip")}</span>
              </div>
            ) : null}
            {older.length ? (
              older.map((rel) => (
                <ReleaseRow
                  key={rel.tag}
                  rel={rel}
                  selected={selected === rel.tag}
                  open={expanded === rel.tag}
                  older
                  onSelect={() => onSelect(rel.tag)}
                />
              ))
            ) : (
              <p className="text-xs text-[var(--color-muted)]">{t("noOlder")}</p>
            )}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">{t("footer")}</p>
          {canUpgrade && selected ? (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => onUpgrade(selected)}
              data-testid="upgrade-button"
            >
              {isOlder ? t("rollBackTo", { tag: selected }) : t("upgradeTo", { tag: selected })}
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}

function ReleaseRow({
  rel,
  selected,
  open,
  latest = false,
  older = false,
  onSelect,
}: {
  rel: SoftwareUpgradeRelease;
  selected: boolean;
  open: boolean;
  latest?: boolean;
  older?: boolean;
  onSelect: () => void;
}) {
  const t = useT("upgrade");
  const time = useTimeLabel();
  const [first, ...rest] = rel.highlights;
  return (
    <div
      data-release={rel.tag}
      className={`mb-2 rounded-xl border bg-[var(--color-surface)] ${
        selected ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : "border-[var(--color-border)]"
      }`}
    >
      <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
        <input type="radio" name="release" checked={selected} onChange={onSelect} onClick={onSelect} />
        <b>{rel.tag}</b>
        {latest ? <span className={CHIP_ACCENT}>{t("latest")}</span> : null}
        {rel.prerelease ? <span className={CHIP_MUTED}>{t("prerelease")}</span> : null}
        <span className="text-xs text-[var(--color-muted)]">{time(epoch(rel.published_at), "date")}</span>
        <span className="flex-1" />
        {older ? <span className={CHIP_MUTED}>{t("rollBackChip")}</span> : null}
        <span aria-hidden className="text-xs text-[var(--color-muted)]">{open ? "▴" : "▾"}</span>
      </label>
      {open ? (
        <div className="px-4 pb-3 text-sm sm:pl-11">
          {first ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {[first, ...rest].map((sec, i) => (
                <div key={`${sec.title}-${i}`} className="rounded-xl bg-[var(--color-bg)] p-3">
                  {sec.title ? <b className="mb-1 block">{sec.title}</b> : null}
                  <ul className="list-disc pl-4 text-xs text-[var(--color-muted)]">
                    {sec.items.map((item, j) => (
                      <li key={j}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">{t("noNotes")}</p>
          )}
          {rel.url ? (
            <a href={rel.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-[var(--color-accent)]">
              {t("fullNotes")}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── history ───────────────────────────────────────────────────────── */

function resultChip(result: string | null, t: (k: string) => string) {
  if (result === "ok") return <span className={CHIP_OK}>{t("resultOk")}</span>;
  if (result === "rolled back") return <span className={CHIP_BAD}>{t("resultRolledBack")}</span>;
  if (result === "interrupted") return <span className={CHIP_BAD}>{t("resultInterrupted")}</span>;
  if (!result) return <span className={CHIP_MUTED}>{t("resultRunning")}</span>;
  return <span className={CHIP_BAD}>{t("resultFailed")}</span>;
}

function HistoryCard({ status }: { status: SoftwareUpgradeStatus }) {
  const t = useT("upgrade");
  const time = useTimeLabel();
  const rows = status.history ?? [];
  return (
    <section data-section="upgrade-history" className={CARD}>
      <h2 className="mb-2 text-sm font-semibold">{t("history")}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">{t("noHistory")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-[13px]">
            <thead>
              <tr className="text-xs text-[var(--color-muted)]">
                <th className="border-b border-[var(--color-border)] p-2 font-medium">{t("when")}</th>
                <th className="border-b border-[var(--color-border)] p-2 font-medium">{t("fromTo")}</th>
                <th className="border-b border-[var(--color-border)] p-2 font-medium">{t("by")}</th>
                <th className="border-b border-[var(--color-border)] p-2 font-medium">{t("result")}</th>
                <th className="border-b border-[var(--color-border)] p-2 font-medium">{t("took")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-history={row.id}>
                  <td className="border-b border-[var(--color-border)] p-2">{time(epoch(row.started), "dateTime")}</td>
                  <td className="border-b border-[var(--color-border)] p-2">
                    {row.from ?? "?"} → {row.to ?? "?"}
                    {row.kind === "rollback" ? <span className={`${CHIP_MUTED} ml-2`}>{t("rollbackRow")}</span> : null}
                  </td>
                  <td className="border-b border-[var(--color-border)] p-2">{row.by ?? "—"}</td>
                  <td className="border-b border-[var(--color-border)] p-2" title={row.error ?? undefined}>
                    {resultChip(row.result, t)}
                  </td>
                  <td className="border-b border-[var(--color-border)] p-2">
                    {tookLabel(row.seconds ?? between(row.started, row.finished))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ── progress + finished ───────────────────────────────────────────── */

const ICON: Record<string, string> = {
  done: "bg-green-50 text-green-700",
  running: "bg-[var(--color-accent)] text-[var(--color-accent-fg)] animate-pulse",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-[var(--color-bg)] text-[var(--color-muted)]",
  pending: "bg-[var(--color-bg)] text-[var(--color-muted)]",
};

function StepRow({ step, index, tag }: { step: SoftwareUpgradeStep; index: number; tag: string }) {
  const t = useT("upgrade");
  const mark = step.state === "done" ? "✓" : step.state === "failed" ? "✕" : step.state === "running" ? "●" : String(index + 1);
  const took = between(step.started, step.finished);
  return (
    <li data-step={step.key} data-state={step.state} className="flex items-start gap-3 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ICON[step.state] ?? ICON.pending}`}>
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <b className="text-sm">{t(`step.${step.key}`, { tag })}</b>
        <div className="text-xs text-[var(--color-muted)]">
          {t(`stepHint.${step.key}`)}
          {step.state === "done" && took != null ? ` · ${tookLabel(took)}` : ""}
        </div>
      </div>
    </li>
  );
}

function JobPanel({
  job,
  reconnecting,
  canUpgrade,
  rollbackTo,
  onRollback,
  onClose,
}: {
  job: SoftwareUpgradeJob;
  reconnecting: boolean;
  canUpgrade: boolean;
  rollbackTo: string | null;
  onRollback: (tag: string) => void;
  onClose: () => void;
}) {
  const t = useT("upgrade");
  const hydrated = useHydrated();
  const time = useTimeLabel();
  const tag = job.to ?? "?";
  const total = job.steps.length || 1;
  const done = job.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const current = job.steps.findIndex((s) => s.state === "running");
  const failed = job.steps.find((s) => s.state === "failed");
  const ok = job.result === "ok";
  const startedAt = epoch(job.started);
  const ago = hydrated && startedAt != null ? time(startedAt, "ago") : "";
  const rollback = job.kind === "rollback";
  return (
    <div data-component="UpgradeJobPanel" data-running={job.running ? "1" : "0"}>
      {!job.running && ok ? (
        <div data-testid="upgrade-done-banner" className="mb-4 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          <b>{rollback ? t("rolledBackTo", { tag }) : t("upgradedTo", { tag })}</b>{" "}
          {t("tookTotal", { took: tookLabel(between(job.started, job.finished)) })}
        </div>
      ) : null}
      {!job.running && !ok ? (
        <div data-testid="upgrade-failed-banner" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">
          <b>{t("failedTitle", { tag })}</b>{" "}
          {job.result === "interrupted"
            ? t("interrupted")
            : job.result === "rolled back"
              ? t("failedRolledBack")
              : t("failedNotRestored")}
          {failed ? <div className="mt-1 text-xs">{t("failedAt", { step: t(`step.${failed.key}`, { tag }) })}</div> : null}
          {job.error ? <div className="mt-1 text-xs">{job.error}</div> : null}
        </div>
      ) : null}
      {reconnecting && job.running ? (
        <div data-testid="upgrade-reconnecting" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          {t("reconnecting")}
        </div>
      ) : null}
      <section className={`${CARD} mx-auto max-w-3xl`}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">
            {job.running
              ? t(rollback ? "rollingBack" : "upgrading", { from: job.from ?? "?", to: tag })
              : t(rollback ? "finishedRollback" : "finished")}
          </h2>
          <span className="flex-1" />
          {job.running && ago ? (
            <span className="text-xs text-[var(--color-muted)]">
              {job.by ? t("startedBy", { ago, by: job.by }) : t("startedAgo", { ago })}
            </span>
          ) : null}
        </div>
        {job.running ? (
          <>
            <div className="mb-1 mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-bg)]">
              <i className="block h-full bg-[var(--color-accent)]" style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {t("stepOf", { n: Math.min(total, (current >= 0 ? current : done) + 1), total })} · {t("carriesOn")}
            </p>
          </>
        ) : null}
        <ul className="mt-2">
          {job.steps.map((step, i) => (
            <StepRow key={step.key} step={step} index={i} tag={tag} />
          ))}
        </ul>
        <details className="mt-2" open={!job.running && !ok}>
          <summary className="cursor-pointer text-xs">{t("showLog")}</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-[#14171f] p-3 font-mono text-xs leading-relaxed text-[#c9d1e0]">
            {job.log.length ? job.log.join("\n") : t("noLog")}
          </pre>
        </details>
        {!job.running ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
            <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
              {ok && !rollback && rollbackTo ? t("rollbackHint", { tag: rollbackTo }) : ""}
            </p>
            <button type="button" className={BTN} onClick={onClose}>
              {t("backToReleases")}
            </button>
            {ok && !rollback && rollbackTo && canUpgrade ? (
              <button type="button" className={BTN} onClick={() => onRollback(rollbackTo)} data-testid="upgrade-rollback">
                {t("rollBackTo", { tag: rollbackTo })}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* ── confirm with password ─────────────────────────────────────────── */

function ConfirmDialog({
  confirm,
  older,
  onCancel,
  onStarted,
}: {
  confirm: NonNullable<Confirm>;
  older: boolean;
  onCancel: () => void;
  onStarted: (status: SoftwareUpgradeStatus) => void;
}) {
  const t = useT("upgrade");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rollback = confirm.kind === "rollback";
  const bullets = useMemo(
    () => [
      t("bulletBackup"),
      t("bulletDowntime"),
      t("bulletRuns"),
      rollback ? t("bulletRollback", { tag: confirm.tag }) : t("bulletDatabase"),
    ],
    [t, rollback, confirm.tag],
  );
  const { run: submit, pending: busy } = useAction(async () => {
    setError(null);
    try {
      const res = await fetch(rollback ? "/api/software-upgrade/rollback" : "/api/software-upgrade/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rollback ? { password } : { version: confirm.tag, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: SoftwareUpgradeStatus; detail?: string };
      if (!res.ok || !body.status) throw new Error(body.detail ?? String(res.status));
      onStarted(body.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
       data-component="UpgradeConfirm" className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-[var(--color-surface)] p-5">
        <h2 className="text-base font-semibold">
          {rollback || older ? t("confirmRollback", { tag: confirm.tag }) : t("confirmUpgrade", { tag: confirm.tag })}
        </h2>
        <ul className="my-3 list-disc pl-5 text-xs">
          {bullets.map((b) => (
            <li key={b} className="my-1">{b}</li>
          ))}
        </ul>
        <label className="mb-1 mt-3 block text-xs font-medium text-[var(--color-muted)]" htmlFor="upgrade-password">
          {t("password")}
        </label>
        <input
          id="upgrade-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
          autoFocus
        />
        {error ? <p className="mt-2 text-xs text-[var(--color-danger)]" role="alert">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
          <ActionButton
            type="submit"
            className={BTN_PRIMARY}
            busy={busy}
            busyLabel={t("starting")}
            disabled={!password}
            data-testid="upgrade-confirm"
          >
            {rollback ? t("startRollback") : t("startUpgrade")}
          </ActionButton>
        </div>
      </form>
    </div>
  );
}

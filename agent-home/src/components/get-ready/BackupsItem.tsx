"use client";

/**
 * Get ready → item 10, Backups (owner only). Encrypted copies of the whole
 * install (database + files) go to S3-compatible storage the owner picks;
 * the server makes one every night, removes old ones, and can prove a copy
 * opens with a restore test in a scratch area. The secret key is sent once
 * and never shown again; the server answers with a short key-ID hint only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { backupsT, pageLang, type BackupsKey, type BackupsLang, type BackupsT } from "@/components/get-ready/backups-t";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill, type Tone } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import type {
  OffsiteBackupSettings,
  OffsiteBackupState,
  OffsiteBackupStatus,
  OffsiteProvider,
} from "@/types";

const API = "/api/backups/offsite";
const POLL_MS = 2_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Busy = null | "load" | "save" | "test" | "run" | "restore-test" | "remove";
type Overall = "done" | "attention" | "notStarted";

const STATE_KEY: Record<OffsiteBackupState, BackupsKey> = {
  unavailable: "stateNotConfigured",
  not_configured: "stateNotConfigured",
  running: "stateRunning",
  backup_failed: "stateBackupFailed",
  needs_first_backup: "stateNeedsFirstBackup",
  backup_late: "stateBackupLate",
  restore_test_failed: "stateRestoreTestFailed",
  needs_restore_test: "stateNeedsRestoreTest",
  ok: "stateOk",
};

const OVERALL_TONE: Record<Overall, Tone> = { done: "success", attention: "warning", notStarted: "muted" };
const PROVIDER_KEY: Record<OffsiteProvider, BackupsKey> = {
  b2: "providerB2",
  s3: "providerS3",
  other: "providerOther",
};

const noSubscribe = () => () => {};

export function overallOf(state: OffsiteBackupState | undefined): Overall {
  if (state === "ok") return "done";
  if (!state || state === "unavailable" || state === "not_configured") return "notStarted";
  return "attention";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function size(bytes: number | undefined): string {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  return body as T;
}

interface Form {
  provider: OffsiteProvider;
  bucket: string;
  key_id: string;
  secret: string;
  endpoint: string;
  region: string;
  time: string;
  keep_days: string;
  schedule: boolean;
}

function formFrom(status: OffsiteBackupStatus | null): Form {
  const target = status?.target;
  return {
    provider: target?.provider ?? "b2",
    bucket: target?.bucket ?? "",
    key_id: "",
    secret: "",
    endpoint: target?.provider === "other" ? target.endpoint : "",
    region: target?.provider === "s3" ? target.region : "",
    time: status?.schedule?.time ?? "03:00",
    keep_days: String(status?.schedule?.keep_days ?? 30),
    schedule: status?.schedule?.enabled ?? true,
  };
}

function NewKey({ value, t, onDone }: { value: string; t: BackupsT; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const href = useMemo(
    () => `data:text/plain;charset=utf-8,${encodeURIComponent(`${value}\n`)}`,
    [value],
  );
  return (
    <div
      data-component="BackupKeyOnce"
      className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <p className="text-sm font-semibold text-[var(--color-warn-text)]">{t("keyTitle")}</p>
      <p className="text-xs text-[var(--color-muted)]">{t("keyBody")}</p>
      <code className="break-all rounded-md bg-[var(--color-bg)] px-2 py-2 font-mono text-xs">{value}</code>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? t("copied") : t("copy")}
        </button>
        <a
          className="inline-flex min-h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs"
          href={href}
          download="aquarium-backup-key.txt"
        >
          {t("download")}
        </a>
        <label className="ml-auto flex min-h-9 items-center gap-2 text-xs">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t("keySaved")}
        </label>
        <button
          type="button"
          disabled={!saved}
          className="min-h-9 rounded-lg bg-[var(--color-accent)] px-3 text-xs text-[var(--color-accent-fg)] disabled:opacity-50"
          onClick={onDone}
        >
          {t("close")}
        </button>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]";
const FIELD = "flex flex-col gap-1 text-xs text-[var(--color-muted)]";
const BTN =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-50";

export function BackupsItem({
  initial = null,
  lang,
  defaultOpen = false,
}: {
  initial?: OffsiteBackupStatus | null;
  lang?: BackupsLang;
  defaultOpen?: boolean;
}) {
  const detected = useSyncExternalStore(noSubscribe, pageLang, () => "en" as const);
  const language = lang ?? detected;
  const t = useMemo(() => backupsT(language), [language]);

  const [status, setStatus] = useState<OffsiteBackupStatus | null>(initial);
  const [open, setOpen] = useState(defaultOpen);
  const [form, setForm] = useState<Form>(() => formFrom(initial));
  const [editSchedule, setEditSchedule] = useState(false);
  const [busy, setBusy] = useState<Busy>(initial ? null : "load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const busyRef = useRef<Busy>(null);
  const wasRunning = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await call<OffsiteBackupStatus>(API);
      setStatus(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    if (initial) return;
    call<OffsiteBackupStatus>(API)
      .then((next) => {
        setStatus(next);
        setForm(formFrom(next));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  }, [initial]);

  const running = status?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, refresh]);

  // Report the outcome once a running job finishes.
  useEffect(() => {
    if (running) {
      wasRunning.current = running.kind;
      return;
    }
    const kind = wasRunning.current;
    if (!kind || !status) return;
    wasRunning.current = null;
    const result = kind === "backup" ? status.last_backup : status.last_restore_test;
    if (result?.ok) setNotice(kind === "backup" ? t("backupDone") : t("restoreDone"));
  }, [running, status, t]);

  async function act(kind: Exclude<Busy, null | "load">, run: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = kind;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  const configured = Boolean(status?.configured);
  const state = status?.state;
  const overall = overallOf(state);
  const keepDays = Number(form.keep_days);

  function save() {
    const needSecret = !configured;
    if (!form.bucket.trim() || (!configured && !form.key_id.trim()) || (needSecret && !form.secret)) {
      setError(t("needFields"));
      return;
    }
    if (form.provider === "other" && !form.endpoint.trim()) {
      setError(t("needEndpoint"));
      return;
    }
    if (!TIME_RE.test(form.time) || !Number.isInteger(keepDays) || keepDays < 1 || keepDays > 3650) {
      setEditSchedule(true);
      return;
    }
    void act("save", async () => {
      const body: OffsiteBackupSettings = {
        provider: form.provider,
        bucket: form.bucket.trim(),
        key_id: form.key_id.trim(),
        secret: form.secret,
        endpoint: form.provider === "other" ? form.endpoint.trim() : "",
        region: form.provider === "s3" ? form.region.trim() : "",
        time: form.time,
        keep_days: keepDays,
        schedule: form.schedule,
      };
      const answer = await call<{ status: OffsiteBackupStatus; new_key?: string }>(API, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatus(answer.status);
      setForm((f) => ({ ...f, key_id: "", secret: "" }));
      setEditSchedule(false);
      if (answer.new_key) setNewKey(answer.new_key);
      setNotice(t("testedOk"));
    });
  }

  function start(kind: "run" | "restore-test") {
    void act(kind, async () => {
      const answer = await call<{ started: boolean; status: OffsiteBackupStatus }>(`${API}/${kind}`, {
        method: "POST",
      });
      setStatus(answer.status);
      if (!answer.status.running) await refresh();
    });
  }

  function testNow() {
    void act("test", async () => {
      if (!configured) {
        setOpen(true);
        return;
      }
      setStatus(await call<OffsiteBackupStatus>(`${API}/test`, { method: "POST" }));
      setNotice(t("testedOk"));
    });
  }

  function stop() {
    void act("remove", async () => {
      setStatus(await call<OffsiteBackupStatus>(API, { method: "DELETE" }));
      setConfirmStop(false);
      setForm(formFrom(null));
    });
  }

  const blocked = busy !== null || Boolean(running);
  const good = status?.last_good_backup;
  const restore = status?.last_restore_test;
  const lastFailed = state === "backup_failed" ? status?.last_backup?.error ?? "" : "";
  const restoreFailed = state === "restore_test_failed" ? restore?.error ?? "" : "";
  const summary = state
    ? t(STATE_KEY[state], { error: lastFailed || restoreFailed })
    : t("loading");
  const phase = running
    ? t(`phase_${running.phase}` as BackupsKey, { days: status?.schedule?.keep_days ?? 30 })
    : "";

  return (
    <li
      data-component="BackupsItem"
      id="item-backups"
      aria-busy={blocked || undefined}
      className="list-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            overall === "done"
              ? "bg-emerald-500/20 text-emerald-300"
              : overall === "attention"
                ? "bg-amber-500/20 text-[var(--color-warn-text)]"
                : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
          }`}
        >
          {overall === "done" ? "✓" : "10"}
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{t("title")}</span>
            <Pill tone={OVERALL_TONE[overall]}>{t(overall)}</Pill>
            <span className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)]">
              {t("required")}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]" data-testid="backups-summary">
            {busy === "load" ? t("loading") : summary}
          </p>
          {configured ? (
            <div className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--color-muted)]">
              <p>{good ? t("lastGood", { when: when(good.at), size: size(good.size) }) : t("lastGoodNever")}</p>
              <p>
                {restore
                  ? t(restore.ok ? "lastTest" : "lastTestFailed", { when: when(restore.at) })
                  : t("lastTestNever")}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 pl-10">
        <button
          type="button"
          className={open ? BTN : BTN_PRIMARY}
          disabled={busy === "load"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t("close") : t("setUp")}
        </button>
        <button
          type="button"
          className={BTN}
          disabled={blocked || state === "unavailable"}
          onClick={testNow}
        >
          {busy === "test" ? (
            <>
              <Spinner /> {t("testing")}
            </>
          ) : (
            t("test")
          )}
        </button>
      </div>

      {running ? (
        <div className="mt-3 flex flex-col gap-1 pl-10" role="status" aria-live="polite" data-testid="backups-progress">
          <div className="flex items-center gap-2 text-xs">
            <Spinner />
            <span className="grow">{phase}</span>
            <span className="text-[var(--color-muted)]">{running.percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${running.percent}%` }} />
          </div>
        </div>
      ) : null}

      {notice && !open ? <p className="mt-2 pl-10 text-xs text-emerald-300">✓ {notice}</p> : null}
      {error && !open ? (
        <p className="mt-2 pl-10 text-xs text-red-300" role="alert">
          ✗ {t("error", { error })}
        </p>
      ) : null}

      {open ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-[var(--color-border)] pt-3" data-testid="backups-panel">
          {state === "unavailable" ? (
            <p className="text-xs text-[var(--color-muted)]">{t("unavailable")}</p>
          ) : (
            <>
              <p className="text-xs text-[var(--color-muted)]">{t("intro")}</p>
              {newKey ? <NewKey value={newKey} t={t} onDone={() => setNewKey(null)} /> : null}
              <div className="grid gap-3 md:grid-cols-2">
                <label className={FIELD}>
                  {t("where")}
                  <select
                    className={INPUT}
                    value={form.provider}
                    disabled={blocked}
                    onChange={(e) => setForm({ ...form, provider: e.target.value as OffsiteProvider })}
                  >
                    {(["b2", "s3", "other"] as const).map((p) => (
                      <option key={p} value={p}>
                        {t(PROVIDER_KEY[p])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={FIELD}>
                  {t("bucket")}
                  <input
                    className={INPUT}
                    value={form.bucket}
                    disabled={blocked}
                    autoComplete="off"
                    placeholder="yourcompany-aquarium-backup"
                    onChange={(e) => setForm({ ...form, bucket: e.target.value })}
                  />
                </label>
                <label className={FIELD}>
                  {t("keyId")}
                  <input
                    className={INPUT}
                    value={form.key_id}
                    disabled={blocked}
                    autoComplete="off"
                    placeholder={status?.target?.key_id_hint ?? ""}
                    onChange={(e) => setForm({ ...form, key_id: e.target.value })}
                  />
                </label>
                <label className={FIELD}>
                  {t("secret")}
                  <input
                    className={INPUT}
                    type="password"
                    value={form.secret}
                    disabled={blocked}
                    autoComplete="new-password"
                    placeholder={configured ? t("secretKept") : ""}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  />
                </label>
                {form.provider === "other" ? (
                  <label className={`${FIELD} md:col-span-2`}>
                    {t("endpoint")}
                    <input
                      className={`${INPUT} font-mono`}
                      value={form.endpoint}
                      disabled={blocked}
                      placeholder="https://s3.example.com"
                      onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                    />
                  </label>
                ) : null}
                {form.provider === "s3" ? (
                  <label className={FIELD}>
                    {t("region")}
                    <input
                      className={INPUT}
                      value={form.region}
                      disabled={blocked}
                      placeholder="eu-central-1"
                      onChange={(e) => setForm({ ...form, region: e.target.value })}
                    />
                  </label>
                ) : null}
              </div>

              {editSchedule ? (
                <div className="grid gap-3 rounded-lg border border-[var(--color-surface-2)] p-2 md:grid-cols-3">
                  <label className="flex min-h-9 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={form.schedule}
                      disabled={blocked}
                      onChange={(e) => setForm({ ...form, schedule: e.target.checked })}
                    />
                    {t("nightly")}
                  </label>
                  <label className={FIELD}>
                    {t("time")}
                    <input
                      className={INPUT}
                      type="time"
                      value={form.time}
                      disabled={blocked || !form.schedule}
                      onChange={(e) => setForm({ ...form, time: e.target.value })}
                    />
                  </label>
                  <label className={FIELD}>
                    {t("keepDays")}
                    <input
                      className={INPUT}
                      type="number"
                      min={1}
                      max={3650}
                      value={form.keep_days}
                      disabled={blocked}
                      onChange={(e) => setForm({ ...form, keep_days: e.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                  {form.schedule
                    ? t("scheduleLine", { time: form.time, days: form.keep_days })
                    : t("scheduleOff", { days: form.keep_days })}
                  <button
                    type="button"
                    className="text-[var(--color-accent)] underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={blocked}
                    onClick={() => setEditSchedule(true)}
                  >
                    {t("change")}
                  </button>
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button type="button" className={BTN_PRIMARY} disabled={blocked} onClick={save}>
                  {busy === "save" ? (
                    <>
                      <Spinner /> {t("testing")}
                    </>
                  ) : (
                    t("saveTest")
                  )}
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={blocked || !configured}
                  onClick={() => start("run")}
                >
                  {busy === "run" || running?.kind === "backup" ? <Spinner /> : null}
                  {good ? t("backupNow") : t("firstBackup")}
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={blocked || !good}
                  onClick={() => start("restore-test")}
                >
                  {busy === "restore-test" || running?.kind === "restore-test" ? <Spinner /> : null}
                  {t("restoreTest")}
                </button>
              </div>
              <p className="text-xs text-[var(--color-muted)]">{t("restoreNote")}</p>

              {notice ? <p className="text-xs text-emerald-300">✓ {notice}</p> : null}
              {error ? (
                <p className="text-xs text-red-300" role="alert">
                  ✗ {t("error", { error })}
                </p>
              ) : null}

              {configured && status?.target ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]">
                  <span className="grow">
                    {t("keptAt", {
                      provider: t(PROVIDER_KEY[status.target.provider]),
                      bucket: status.target.bucket,
                      hint: status.target.key_id_hint,
                    })}
                    {typeof status.copies === "number" ? ` · ${t("copies", { count: status.copies })}` : ""}
                  </span>
                  <button type="button" className={BTN} disabled={blocked} onClick={() => setConfirmStop(true)}>
                    {t("stop")}
                  </button>
                </div>
              ) : null}
              {configured && status?.key_exists && !newKey ? (
                <p className="text-xs text-[var(--color-muted)]">{t("existingKey")}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {confirmStop ? (
        <ConfirmDialog
          title={t("stopTitle")}
          body={t("stopBody")}
          confirmLabel={t("stopConfirm")}
          cancelLabel={t("cancel")}
          busy={busy === "remove"}
          onConfirm={stop}
          onCancel={() => setConfirmStop(false)}
        />
      ) : null}
    </li>
  );
}

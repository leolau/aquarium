"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ModelPerformance } from "@/components/models/ModelPerformance";
import { ModelPickerSheet } from "@/components/models/ModelPickerSheet";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import { withProfileBody, withProfileQuery } from "@/lib/chat/profile";
import type {
  AuxTaskAssignment,
  ModelsOverviewResponse,
  ModelsPerformanceResponse,
  ModelUsageEntry,
  PinnedModelCard,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/** Which slot the picker is editing — the main card or one aux role. */
export type ModelSlot =
  | { kind: "main" }
  | { kind: "aux"; task: string; label: string; hint: string };

/** Display metadata per auxiliary task slot (order = display order). */
const AUX_ROLES: readonly { task: string; label: string; hint: string; top: boolean }[] = [
  { task: "vision", label: "Vision", hint: "image analysis", top: true },
  { task: "compression", label: "Compression", hint: "context compaction", top: true },
  { task: "web_extract", label: "Web extract", hint: "page summarization", top: true },
  { task: "title_generation", label: "Title generation", hint: "session titles", top: true },
  { task: "approval", label: "Approval", hint: "smart auto-approve", top: false },
  { task: "mcp", label: "MCP", hint: "tool routing", top: false },
  { task: "skills_hub", label: "Skills hub", hint: "skill search", top: false },
  { task: "triage_specifier", label: "Triage specifier", hint: "kanban spec fleshing", top: false },
  { task: "kanban_decomposer", label: "Kanban decomposer", hint: "task decomposition", top: false },
  { task: "profile_describer", label: "Profile describer", hint: "auto profile descriptions", top: false },
  { task: "curator", label: "Curator", hint: "skill-usage review", top: false },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0";
}

function formatContext(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${m}M context`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K context`;
  return `${n} ctx`;
}

/** What a role row shows on the right — pinned model, or "auto → main" — and its provider. */
function slotDisplay(
  assignment: AuxTaskAssignment | undefined,
  main: { provider: string; model: string },
): { model: string; provider: string } {
  if (!assignment || assignment.provider === "auto" || !assignment.provider) {
    return { model: `auto → ${main.model || "main"}`, provider: main.provider };
  }
  return { model: assignment.model || "provider default", provider: assignment.provider };
}

/** Which configured slot a usage row's model+provider currently serves. */
function slotTagFor(
  usage: ModelUsageEntry,
  main: { provider: string; model: string },
  tasks: AuxTaskAssignment[],
): string {
  if (usage.model === main.model && (!main.provider || usage.provider === main.provider)) {
    return "main";
  }
  const hit = tasks.find(
    (t) =>
      t.provider !== "auto" &&
      t.model &&
      usage.model === t.model &&
      (!usage.provider || usage.provider === t.provider),
  );
  return hit ? hit.task.replace(/_/g, " ") : "not configured";
}

export function ModelsView({
  initial,
  profile,
}: {
  initial: ModelsOverviewResponse;
  profile?: string;
}) {
  const [data, setData] = useState(initial);
  const [slot, setSlot] = useState<ModelSlot | null>(null);
  const [showAllRoles, setShowAllRoles] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<PinnedModelCard[] | null>(null);
  const [perf, setPerf] = useState<ModelsPerformanceResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const testMain = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withProfileBody({ scope: "main" }, profile)),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        model?: string;
        latency_ms?: number;
        reply?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setTestResult({ ok: false, text: body.detail ?? "Test request failed." });
      } else if (body.ok) {
        const secs = ((body.latency_ms ?? 0) / 1000).toFixed(1);
        setTestResult({
          ok: true,
          text: `${body.model ?? "model"} replied in ${secs}s${body.reply ? ` — “${body.reply}”` : ""}`,
        });
      } else {
        setTestResult({ ok: false, text: body.error ?? "Test failed." });
      }
    } catch {
      setTestResult({ ok: false, text: "Couldn't reach the test endpoint." });
    } finally {
      setTesting(false);
    }
  }, [profile, testing]);

  // Lazy: the per-call ledger read is additive — it loads after first
  // paint so the config sections never wait on it.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(withProfileQuery("/api/models/performance", profile), {
          cache: "no-store",
        });
        if (!res.ok) return;
        if (active) setPerf((await res.json()) as ModelsPerformanceResponse);
      } catch {
        // Section stays hidden on failure — additive, not critical.
      }
    })();
    return () => {
      active = false;
    };
  }, [profile]);

  // Lazy: the pinned-cards fan-out (projects list → per-project boards) is
  // too heavy for first paint, so it loads after the page is up. `null`
  // means "still loading or failed" — the section only renders when there
  // are cards to warn about.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(withProfileQuery("/api/models/pinned", profile), {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { pinned?: PinnedModelCard[] };
        if (active) setPinned(body.pinned ?? []);
      } catch {
        // Section stays hidden on failure — it's additive, not critical.
      }
    })();
    return () => {
      active = false;
    };
  }, [profile]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(withProfileQuery("/api/models/overview", profile), {
        cache: "no-store",
      });
      if (res.ok) {
        const body = (await res.json()) as ModelsOverviewResponse;
        setData(body);
        setError(null);
      }
    } catch {
      // Keep showing the last good data; the next change retries.
    } finally {
      setRefreshing(false);
    }
  }, [profile]);

  const assignments = useMemo(() => {
    const map = new Map<string, AuxTaskAssignment>();
    for (const t of data.auxiliary.tasks) map.set(t.task, t);
    return map;
  }, [data.auxiliary.tasks]);

  const roles = showAllRoles ? AUX_ROLES : AUX_ROLES.filter((r) => r.top);
  const hiddenCount = AUX_ROLES.length - AUX_ROLES.filter((r) => r.top).length;
  const usage = useMemo(
    () =>
      [...data.usage].sort(
        (a, b) =>
          (b.actual_cost || b.estimated_cost) - (a.actual_cost || a.estimated_cost),
      ),
    [data.usage],
  );
  const caps = data.info.capabilities ?? {};
  const ctx = formatContext(data.info.effective_context_length);

  return (
    <div data-component="ModelsView" className="flex flex-col gap-5">
      {/* ── Main model ── */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Main model
        </div>
        <div className="mt-1.5 text-lg font-semibold">
          {data.info.model || "—"}
        </div>
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          {data.info.provider || "no provider"}
          {ctx ? ` · ${ctx}` : ""}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {caps.supports_tools ? <Pill tone="success">tools</Pill> : null}
          {caps.supports_vision ? <Pill tone="success">vision</Pill> : null}
          {caps.supports_reasoning ? <Pill tone="success">reasoning</Pill> : null}
          {caps.model_family ? <Pill tone="muted">{caps.model_family}</Pill> : null}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSlot({ kind: "main" })}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3.5 py-1.5 text-xs"
          >
            Change
          </button>
          <ActionButton busyLabel="Testing…"
            onAction={() => testMain()}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3.5 py-1.5 text-xs disabled:opacity-60"
          >
            {testing ? <Spinner /> : null}
            {testing ? "Testing…" : "Test"}
          </ActionButton>
        </div>
        {testResult ? (
          <p
            className={`mt-2 rounded-lg px-3 py-1.5 text-xs ${
              testResult.ok
                ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                : "bg-red-500/10 text-red-300"
            }`}
          >
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.text}
          </p>
        ) : null}
      </section>

      {/* ── Task roles ── */}
      <section>
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Task roles
        </h2>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3">
          {roles.map((role) => {
            const a = assignments.get(role.task);
            const isAuto = !a || a.provider === "auto" || !a.provider;
            const shown = slotDisplay(a, data.auxiliary.main);
            return (
              <button
                key={role.task}
                type="button"
                onClick={() => setSlot({ kind: "aux", task: role.task, label: role.label, hint: role.hint })}
                className="flex w-full items-center gap-3 border-b border-[var(--color-border)] py-3 text-left last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block text-sm">{role.label}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">{role.hint}</span>
                </span>
                <span className="ml-auto min-w-0 text-right">
                  <span
                    className={`block truncate text-[13px] ${
                      isAuto ? "text-[var(--color-muted)]" : "text-[var(--color-accent)]"
                    }`}
                  >
                    {shown.model}
                  </span>
                  {shown.provider ? (
                    <span className="block truncate text-[11px] text-[var(--color-muted)]">
                      {shown.provider}
                    </span>
                  ) : null}
                </span>
                <span className="text-[var(--color-muted)]">›</span>
              </button>
            );
          })}
          {!showAllRoles && hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAllRoles(true)}
              className="flex w-full items-center gap-3 py-3 text-left text-[var(--color-muted)]"
            >
              <span className="text-sm">+{hiddenCount} more roles</span>
              <span className="ml-auto text-[13px]">
                {AUX_ROLES.filter((r) => !r.top).every(
                  (r) => {
                    const a = assignments.get(r.task);
                    return !a || a.provider === "auto" || !a.provider;
                  },
                )
                  ? "all auto"
                  : "some pinned"}
              </span>
              <span>⌄</span>
            </button>
          ) : null}
        </div>
      </section>

      {/* ── Performance (per-call telemetry) ── */}
      <ModelPerformance perf={perf} />

      {/* ── In use ── */}
      <section>
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          In use — last 30 days
        </h2>
        {usage.length === 0 ? (
          <p className="px-1 text-sm text-[var(--color-muted)]">No recorded usage.</p>
        ) : (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3">
            {usage.map((u) => {
              const tag = slotTagFor(u, data.auxiliary.main, data.auxiliary.tasks);
              const tokens = u.input_tokens + u.output_tokens;
              const cost = u.actual_cost || u.estimated_cost;
              return (
                <div
                  key={`${u.provider}:${u.model}`}
                  className="border-b border-[var(--color-border)] py-2.5 last:border-b-0"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{u.model}</span>
                    <Pill tone={tag === "not configured" ? "muted" : "accent"}>{tag}</Pill>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2 text-[11px] text-[var(--color-muted)]">
                    {u.provider ? <span className="min-w-0 truncate">{u.provider}</span> : null}
                    <span className="ml-auto shrink-0">
                      {u.sessions} sessions · {formatTokens(tokens)} tok · {formatCost(cost)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Pinned cards (model_override) — lazy, only when any exist ── */}
      {pinned && pinned.length > 0 ? (
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Pinned cards
          </h2>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3">
            {pinned.map((c) => (
              <Link
                key={c.task_id}
                href={`/projects/${c.project_slug}/cards/${c.task_id}`}
                className="flex items-center gap-2 border-b border-[var(--color-border)] py-2.5 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.title}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">
                    {c.project_name} · {c.status}
                  </span>
                </span>
                <span className="ml-auto shrink-0 text-[13px] text-[var(--color-warn-text)]">
                  {c.model}
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-1 px-1 text-[11px] text-[var(--color-muted)]">
            These cards run their pinned model no matter what the slots above say.
          </p>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      <p className="px-1 text-xs text-[var(--color-muted)]">
        Changes apply to new sessions — running workers keep their current
        model.
        {refreshing ? (
          <span className="ml-1 inline-flex items-center gap-1 align-middle">
            <Spinner /> refreshing…
          </span>
        ) : null}
      </p>

      {slot ? (
        <ModelPickerSheet
          slot={slot}
          currentMain={data.auxiliary.main}
          currentAssignment={
            slot.kind === "aux" ? assignments.get(slot.task) : undefined
          }
          profile={profile}
          onClose={() => setSlot(null)}
          onChanged={() => {
            setSlot(null);
            void refresh();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

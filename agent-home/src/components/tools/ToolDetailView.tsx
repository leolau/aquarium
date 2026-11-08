"use client";

import { useState } from "react";

import { AppSecretsForm } from "@/components/apps-secrets/AppSecretsForm";
import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useT } from "@/i18n/client";
import type { Tool } from "@/types";

import { AppIcon } from "./AppIcon";
import { ToolActionsSheet } from "./ToolActionsSheet";
import {
  appApiPath,
  canManageApp,
  deriveHealth,
  displayName,
  openUrl,
  providerOf,
  sectionOf,
  type AppHealth,
  type Viewer,
} from "./toolsModel";

export interface ToolDetailData {
  tool: Tool;
  health?: AppHealth | null;
  deployments?: Array<{ id?: string; url?: string | null; state?: string | null; created_at?: string | null }>;
  last_run?: { run_id?: string | null; project_slug?: string | null; status?: string | null } | null;
  mcp?: { enabled?: boolean; status?: string | null; tools?: number | null } | null;
}

export const FEEDBACK_MAX = 4000;

function LogsTail({ tool }: { tool: Tool }) {
  const t = useT("tools");
  const [lines, setLines] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${appApiPath(tool, "/logs")}?mode=${tool.mode}&lines=200`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { lines?: string[]; logs?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? t("detail.logsFailed"));
      setLines(body.lines ?? (body.logs ? body.logs.split("\n") : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("detail.logsFailed"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div data-component="ToolLogsTail" className="flex flex-col gap-2">
      <button type="button" aria-busy={loading || undefined} className="min-h-[44px] self-start rounded-xl border border-[var(--color-border)] px-4 text-sm" onClick={() => void load()} disabled={loading}>
        {loading ? t("detail.logsLoading") : lines ? t("detail.logsReload") : t("detail.logsShow")}
      </button>
      {error ? <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p> : null}
      {lines ? (
        <pre className="max-h-72 overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-fg)] [overflow-wrap:anywhere] whitespace-pre-wrap">{lines.join("\n") || t("detail.logsEmpty")}</pre>
      ) : null}
    </div>
  );
}

function FeedbackForm({ tool }: { tool: Tool }) {
  const t = useT("tools");
  const action = useProjectAction();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const ok = text.trim().length > 0 && text.length <= FEEDBACK_MAX;
  return (
    <form
      data-component="ToolFeedbackForm"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        void action.run(appApiPath(tool, "/feedback"), {
          body: { text: text.trim(), mode: tool.mode },
          onSuccess: () => {
            setText("");
            setSent(true);
          },
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {t("detail.feedbackLabel")}
        <textarea
          value={text}
          maxLength={FEEDBACK_MAX}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
          rows={3}
          className="rounded-xl border border-[var(--color-border)] bg-transparent p-3"
        />
      </label>
      <ActionButton type="submit" busy={action.busy} disabled={!ok} pendingLabel={t("actions.saving")} className="min-h-[44px] self-start rounded-xl bg-[var(--color-accent)] px-4 text-sm text-[var(--color-accent-fg)]">
        {t("detail.feedbackSend")}
      </ActionButton>
      {sent ? <p className="text-sm text-[var(--color-muted)]">{t("detail.feedbackSent")}</p> : null}
      {action.error ? <p role="alert" className="text-sm text-[var(--color-danger)]">{action.error}</p> : null}
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-[var(--color-border)] py-3 last:border-b-0 sm:flex-row sm:gap-3">
      <dt className="w-36 shrink-0 text-sm text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** `/tools/[name]`: status, URLs, last build, deployments, logs, feedback, MCP. */
export function ToolDetailView({ data, viewer }: { data: ToolDetailData; viewer: Viewer | null }) {
  const t = useT("tools");
  const { tool } = data;
  const [sheet, setSheet] = useState(false);
  const section = sectionOf(tool);
  const kind = section === "external" ? "external" : "local";
  const health = deriveHealth(tool, data.health);
  const url = openUrl(tool);
  const devUrl = section === "local" ? `/apps-dev/${encodeURIComponent(tool.name)}/` : null;
  const prodUrl = section === "local" ? `/apps/${encodeURIComponent(tool.name)}/` : tool.public_url;
  const card = "rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5";
  const heading = "mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]";
  return (
    <div data-component="ToolDetailView" data-kind={kind} className="grid gap-5 pb-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start lg:pb-8">
      <div className="flex min-w-0 flex-col gap-5">
      <section className={card}>
      <div className="flex flex-wrap items-center gap-4">
        <AppIcon tool={tool} kind={kind} provider={providerOf(tool, data.health)} health={health} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{displayName(tool)}</h2>
          <p className="text-xs text-[var(--color-muted)]">
            {t(`kind.${kind}`)} · {t(`health.${health}`)}
          </p>
        </div>
      </div>
      {tool.description ? <p className="mt-3 text-sm">{tool.description}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm text-[var(--color-accent-fg)]">
            {t("actions.open")}
            {kind === "external" ? " ↗" : ""}
          </a>
        ) : null}
        <button type="button" data-action="all-actions" onClick={() => setSheet(true)} className="min-h-[44px] rounded-xl border border-[var(--color-border)] px-4 text-sm">
          {t("detail.allActions")}
        </button>
        <a href="#tool-feedback" className="inline-flex min-h-[44px] items-center px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]">
          {t("detail.askAgent")}
        </a>
      </div>
      <dl className="flex flex-col gap-2">
        <Row label={t("detail.status")}>{t(`health.${health}`)}</Row>
        {prodUrl ? <Row label={t("detail.prodUrl")}>{prodUrl}</Row> : null}
        {devUrl ? <Row label={t("detail.devUrl")}>{devUrl}</Row> : null}
        {tool.release_sha ? <Row label={t("detail.release")}>{tool.release_sha.slice(0, 12)}</Row> : null}
        {data.last_run ? (
          <Row label={t("detail.lastRun")}>
            {data.last_run.project_slug && data.last_run.run_id ? (
              <a className="underline" href={`/projects/${data.last_run.project_slug}/runs/${data.last_run.run_id}`}>
                {data.last_run.status ?? data.last_run.run_id}
              </a>
            ) : (
              (data.last_run.status ?? "—")
            )}
          </Row>
        ) : null}
        <Row label={t("detail.mcp")}>
          {data.mcp ? (data.mcp.enabled ? t("detail.mcpOn") : t("detail.mcpOff")) : t("detail.mcpUnknown")}
        </Row>
      </dl>
      </section>
      {data.deployments?.length ? (
        <section className={card}>
          <h3 className={heading}>{t("detail.deployments")}</h3>
          <ul className="flex flex-col divide-y divide-[var(--color-border)] text-sm">
            {data.deployments.map((d, i) => (
              <li key={d.id ?? i} className="py-2.5 [overflow-wrap:anywhere]">
                {d.state ?? "—"} {d.created_at ? `· ${d.created_at}` : ""} {d.url ? `· ${d.url}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {section === "local" ? (
        <section className={card}>
          <h3 className={heading}>{t("detail.logs")}</h3>
          <LogsTail tool={tool} />
        </section>
      ) : null}
      </div>
      <aside className="flex min-w-0 flex-col gap-5">
      <section id="tool-feedback" className={card}>
        <h3 className={heading}>{t("detail.feedback")}</h3>
        <FeedbackForm tool={tool} />
      </section>
      {section === "local" ? (
        <section className={card}>
        <AppSecretsForm
          name={tool.name}
          mode={tool.mode}
          secretNames={tool.secret_names ?? []}
          canEdit={canManageApp(viewer, tool)}
        />
        </section>
      ) : null}
      </aside>
      {sheet ? <ToolActionsSheet tool={tool} kind={kind} health={health} viewer={viewer} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}

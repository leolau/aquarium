"use client";

import { InfoTip } from "@/components/ui/InfoTip";
import { useLocale, useT } from "@/i18n/client";

import { capitalized, timeAgo } from "./timeAgo";

/** `hermes_cli.app_store.DEPLOYMENT_STATUSES`: newest good prod is live, newest good dev the test copy. */
export type DeploymentStatus = "live" | "test" | "superseded" | "failed" | "building";

export interface ToolDeployment {
  id?: string;
  status?: DeploymentStatus | null;
  mode?: string | null;
  url?: string | null;
  source_sha?: string | null;
  created_at?: string | null;
  /** Helper error text; only sent to people who may manage the app. */
  error?: string | null;
  /** Older BFF shape (before `status`). */
  state?: string | null;
}

const STATUSES: readonly DeploymentStatus[] = ["live", "test", "superseded", "failed", "building"];

const TONE: Record<DeploymentStatus, string> = {
  live: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  test: "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]",
  superseded: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
  failed: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  building: "bg-[var(--color-surface-2)] text-[var(--color-fg)]",
};

function statusOf(d: ToolDeployment): DeploymentStatus | null {
  const raw = d.status ?? null;
  return raw && (STATUSES as readonly string[]).includes(raw) ? raw : null;
}

/** Figma `Tool detail` (24:6274) Deployments card: a status pill, when, and where. */
export function ToolDeployments({ deployments }: { deployments: readonly ToolDeployment[] }) {
  const t = useT("tools");
  const locale = useLocale();
  return (
    <section
      data-component="ToolDeployments"
      className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5"
    >
      <div className="mb-1 flex items-center gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("detail.deployments")}
        </h3>
        <InfoTip label={t("detail.deploymentsInfoLabel")}>{t("detail.deploymentsInfo")}</InfoTip>
      </div>
      {deployments.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{t("detail.deploymentsEmpty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)] text-sm">
          {deployments.map((d, i) => {
            const status = statusOf(d);
            const when = timeAgo(d.created_at, locale);
            const sha = d.source_sha ? t("detail.deploymentRelease", { sha: d.source_sha.slice(0, 12) }) : null;
            const where =
              status === "failed" && d.error
                ? d.error
                : status === "superseded"
                  ? (sha ?? d.url)
                  : (d.url ?? sha);
            const detail = [when ? capitalized(when) : null, where].filter(Boolean).join(" · ");
            return (
              <li
                key={d.id ?? i}
                data-deployment={d.id}
                data-status={status ?? undefined}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3"
              >
                {status ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs ${TONE[status]}`}
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                    {t(`detail.deploymentStatus.${status}`)}
                  </span>
                ) : (
                  <span className="text-xs text-[var(--color-muted)]">{d.state ?? "—"}</span>
                )}
                <span
                  className="min-w-0 flex-1 text-[var(--color-muted)] [overflow-wrap:anywhere]"
                  suppressHydrationWarning
                >
                  {detail || "—"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

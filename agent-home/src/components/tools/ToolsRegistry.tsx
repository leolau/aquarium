"use client";

import Link from "next/link";

import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n/client";
import type { Tool, ToolsResponse } from "@/types";

import { AppGrid } from "./AppGrid";
import { QuotaStrip, type AppQuotaSummary } from "./QuotaStrip";
import {
  displayName,
  healthByName,
  sectionOf,
  type ToolsHealthResponse,
  type Viewer,
} from "./toolsModel";

/**
 * Home → Tools v2 (FG-33 §7): "On this box" (local apps), "Hosted elsewhere"
 * (external apps) and "Helpers & services" (everything else, as text rows,
 * which is also where unknown kinds fall back). The list is already C2-scoped
 * upstream: the caller's own apps plus shared ones.
 */
export type ToolsPageData = ToolsResponse &
  ToolsHealthResponse & {
    quota?: AppQuotaSummary | null;
    builds?: Array<{ name: string; run_id?: string | null; project_slug?: string | null }>;
  };

function HelperRow({ tool }: { tool: Tool }) {
  const t = useT("tools");
  return (
    <li data-component="ToolRow">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{displayName(tool)}</span>
          <Pill tone={tool.enabled ? "success" : "muted"}>{tool.enabled ? t("helper.on") : t("helper.off")}</Pill>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {t.has(`helperKind.${tool.kind}`) ? t(`helperKind.${tool.kind}`) : tool.kind} ·{" "}
          {tool.visibility === "shared" ? t("helper.shared") : t("helper.private")}
        </p>
      </div>
    </li>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section data-component="ToolsSection" data-section={id} aria-labelledby={`tools-${id}`} className="flex flex-col gap-3">
      <div>
        <h2 id={`tools-${id}`} className="text-base font-semibold">
          {title}
        </h2>
        {hint ? <p className="text-xs text-[var(--color-muted)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function BuildingTiles({ builds }: { builds: NonNullable<ToolsPageData["builds"]> }) {
  const t = useT("tools");
  if (!builds.length) return null;
  return (
    <ul data-component="BuildingTiles" className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
      {builds.map((b) => (
        <li key={b.name}>
          <Link
            href={b.project_slug && b.run_id ? `/projects/${b.project_slug}/runs/${b.run_id}` : "/projects"}
            className="flex min-h-[44px] flex-col items-center gap-1.5"
            aria-label={t("tile.building", { name: b.name })}
          >
            <span className="h-16 w-16 animate-pulse rounded-[22%] bg-[var(--color-border)]" aria-hidden="true" />
            <span className="line-clamp-2 text-center text-xs">{b.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function EmptyApps() {
  const t = useT("tools");
  return (
    <div data-component="ToolsEmpty" className="flex flex-col gap-2 rounded-2xl border border-dashed border-[var(--color-border)] p-4">
      <p className="text-sm text-[var(--color-muted)]">{t("empty.body")}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          className="inline-flex min-h-[44px] items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm text-white"
          href={`/chat?draft=${encodeURIComponent(t("empty.localPrompt"))}`}
        >
          {t("empty.local")}
        </Link>
        <Link
          className="inline-flex min-h-[44px] items-center rounded-xl border border-[var(--color-border)] px-4 text-sm"
          href={`/chat?draft=${encodeURIComponent(t("empty.externalPrompt"))}`}
        >
          {t("empty.external")}
        </Link>
      </div>
    </div>
  );
}

export function ToolsRegistry({ data, viewer = null }: { data: ToolsPageData; viewer?: Viewer | null }) {
  const t = useT("tools");
  if (!data.configured) {
    return (
      <div data-component="ToolsRegistry" className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-muted)]">{t("notConfigured")}</p>
      </div>
    );
  }
  const health = healthByName(data);
  const local = data.tools.filter((tool) => sectionOf(tool) === "local");
  const external = data.tools.filter((tool) => sectionOf(tool) === "external");
  const helpers = data.tools.filter((tool) => sectionOf(tool) === "helper");
  const builds = data.builds ?? [];
  const noApps = !local.length && !external.length && !builds.length;
  return (
    <div data-component="ToolsRegistry" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-muted)]">{t("intro")}</p>
        <QuotaStrip quota={data.quota} />
      </div>
      {noApps ? <EmptyApps /> : null}
      {local.length || builds.length ? (
        <Section id="local" title={t("section.local")} hint={t("section.localHint")}>
          <BuildingTiles builds={builds} />
          {local.length ? <AppGrid tools={local} kind="local" health={health} viewer={viewer} label={t("section.local")} /> : null}
        </Section>
      ) : null}
      {external.length ? (
        <Section id="external" title={t("section.external")} hint={t("section.externalHint")}>
          <AppGrid tools={external} kind="external" health={health} viewer={viewer} label={t("section.external")} />
        </Section>
      ) : null}
      <Section id="helpers" title={t("section.helpers")}>
        {helpers.length ? (
          <ul data-component="ToolList" className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {helpers.map((tool) => (
              <HelperRow key={tool.id} tool={tool} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">{t("helper.none")}</p>
        )}
        <p className="text-xs text-[var(--color-muted)]">
          {t("helper.settingsHint")}{" "}
          <Link href="/settings/tools" className="text-[var(--color-accent)] underline">
            {t("helper.settingsLink")}
          </Link>
        </p>
      </Section>
    </div>
  );
}

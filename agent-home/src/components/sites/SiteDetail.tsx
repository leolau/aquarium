"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { secondaryButtonClass } from "@/components/ui/Sheet";
import { useRefresh } from "@/components/ui/useRefresh";
import { useT } from "@/i18n";
import type { DirectoryEntry } from "@/types";
import type { SiteDesign, SiteGrant, SiteRun, SiteSource, SiteTable } from "@/types/sites";

import { DataTab } from "./DataTab";
import { DesignTab } from "./DesignTab";
import { RunsTab } from "./RunsTab";
import { ScheduleTab } from "./ScheduleTab";
import { SharingTab } from "./SharingTab";
import {
  JSON_HEADERS,
  SITE_STATUS_TONE,
  SITE_TABS,
  designEntities,
  personName,
  pickDesigns,
  readJson,
  sitePath,
  type SiteTab,
} from "./format";

/**
 * One site: header (status, owner, pause/resume) over the five tabs. What a
 * person can change follows their grant — read grantees see, admins manage;
 * the server enforces the same rule on every route.
 */
export function SiteDetail({
  site,
  designs,
  tables,
  runs,
  grants,
  directory,
  me,
  initialTab,
}: {
  site: SiteSource;
  designs: SiteDesign[];
  tables: SiteTable[];
  runs: SiteRun[];
  /** Null when the viewer only has read access (the grants route is admin-only). */
  grants: SiteGrant[] | null;
  directory: DirectoryEntry[];
  me: string;
  initialTab: SiteTab;
}) {
  const t = useT("sites");
  const router = useRouter();
  const pathname = usePathname() ?? `/sites/${site.id}`;
  const { refresh } = useRefresh();
  const canManage = site.access === "admin";
  const tabs = SITE_TABS.filter((x) => x !== "sharing" || (canManage && grants !== null));
  const [tab, setTab] = useState<SiteTab>(tabs.includes(initialTab) ? initialTab : "design");
  const [error, setError] = useState<string | null>(null);
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const { approved, proposed } = pickDesigns(designs);

  function select(next: SiteTab) {
    setTab(next);
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  async function setPaused(paused: boolean) {
    setError(null);
    try {
      await readJson(
        await fetch(sitePath(site.id), {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ status: paused ? "paused" : "active" }),
        }),
      );
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div data-component="SiteDetail" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone={SITE_STATUS_TONE[site.status] ?? "muted"}>{t(`status.${site.status}`)}</Pill>
        <a href={site.base_url} target="_blank" rel="noreferrer" className="truncate text-[var(--color-accent)] underline">
          {site.base_url}
        </a>
        <span className="text-[var(--color-muted)]">
          · {t("detail.owner", { who: site.owner_user_id === me ? t("list.you") : personName(people, site.owner_user_id) })}
        </span>
        <span className="text-[var(--color-muted)]">
          · {site.login_saved ? t("detail.loginSaved") : site.login_url ? t("detail.loginMissing") : t("detail.publicOnly")}
        </span>
        <span className="text-[var(--color-muted)]">· {t(`access.${site.access ?? "read"}`)}</span>
        {canManage && (site.status === "active" || site.status === "paused") ? (
          <ActionButton
            className={`${secondaryButtonClass} ml-auto`}
            onAction={() => setPaused(site.status === "active")}
          >
            {site.status === "active" ? t("detail.pause") : t("detail.resume")}
          </ActionButton>
        ) : null}
      </div>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {proposed && tab !== "design" ? (
        <InlineAlert
          tone="warn"
          action={
            <button type="button" className="text-xs underline" onClick={() => select("design")}>
              {t("detail.review")}
            </button>
          }
        >
          {t("detail.proposalWaiting", { version: proposed.version })}
        </InlineAlert>
      ) : null}
      <div role="tablist" aria-label={t("detail.tabsLabel")} className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            onClick={() => select(x)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              tab === x ? "border-[var(--color-accent)] font-medium" : "border-transparent text-[var(--color-muted)]"
            }`}
          >
            {t(`tabs.${x}`)}
            {x === "design" && proposed ? <span className="ml-1 text-[var(--color-warn-text)]">●</span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "design" ? <DesignTab siteId={site.id} designs={designs} canManage={canManage} people={people} /> : null}
        {tab === "data" ? <DataTab siteId={site.id} tables={tables} /> : null}
        {tab === "runs" ? (
          <RunsTab
            siteId={site.id}
            runs={runs}
            tables={tables}
            canManage={canManage}
            canRefresh={approved !== null}
            defaultMode={site.default_refresh_mode}
          />
        ) : null}
        {tab === "sharing" && grants ? (
          <SharingTab siteId={site.id} ownerId={site.owner_user_id} grants={grants} directory={directory} me={me} />
        ) : null}
        {tab === "schedule" ? (
          <ScheduleTab site={site} entities={designEntities(approved ?? proposed)} canManage={canManage} />
        ) : null}
      </div>
    </div>
  );
}

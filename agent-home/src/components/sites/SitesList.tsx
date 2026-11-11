"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Pill } from "@/components/ui/Pill";
import { useLocale, useT } from "@/i18n";
import type { SiteRun, SiteSource } from "@/types/sites";

import { SITE_STATUS_TONE, formatWhen, nextCronRun, personName, runTone } from "./format";

export interface SiteListItem {
  site: SiteSource;
  lastRun: SiteRun | null;
}

type Filter = "all" | "mine" | "shared";

/** The Sites list: every site this person can see, with its run health. */
export function SitesList({
  items,
  people,
  me,
  canCreate,
  now = new Date(),
}: {
  items: SiteListItem[];
  people: Record<string, string>;
  me: string;
  canCreate: boolean;
  now?: Date;
}) {
  const t = useT("sites");
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(
    () =>
      items.filter(({ site }) =>
        filter === "all" ? true : filter === "mine" ? site.owner_user_id === me : site.owner_user_id !== me,
      ),
    [items, filter, me],
  );

  if (items.length === 0) {
    return (
      <div data-component="SitesList">
        <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center">
          <p className="font-medium">{t("list.emptyTitle")}</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {canCreate ? t("list.emptyBody") : t("list.emptyBodyNoCreate")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-component="SitesList" className="space-y-3">
      <div role="tablist" aria-label={t("list.filterLabel")} className="flex flex-wrap gap-2">
        {(["all", "mine", "shared"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === f
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            {t(`list.filter.${f}`)}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        {shown.map(({ site, lastRun }) => {
          const next = site.status === "active" ? nextCronRun(site.schedule_cron, now) : null;
          return (
            <li key={site.id}>
              <Link
                href={`/sites/${site.id}`}
                data-site={site.slug}
                className="grid gap-2 px-4 py-3 hover:bg-[var(--color-surface-2)] sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{site.name}</span>
                    <Pill tone={SITE_STATUS_TONE[site.status] ?? "muted"}>{t(`status.${site.status}`)}</Pill>
                    {site.access === "read" ? <Pill>{t("access.read")}</Pill> : null}
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted)]">{site.base_url}</div>
                </div>
                <div className="text-xs">
                  <div className="text-[var(--color-muted)]">{t("list.owner")}</div>
                  <div>{site.owner_user_id === me ? t("list.you") : personName(people, site.owner_user_id)}</div>
                </div>
                <div className="text-xs">
                  <div className="text-[var(--color-muted)]">{t("list.lastRun")}</div>
                  {lastRun ? (
                    <div className="flex items-center gap-1">
                      <Pill tone={runTone(lastRun.status)}>{t(`runStatus.${lastRun.status}`)}</Pill>
                      <span>{formatWhen(lastRun.started_at, locale)}</span>
                    </div>
                  ) : (
                    <div>{t("list.never")}</div>
                  )}
                </div>
                <div className="text-xs">
                  <div className="text-[var(--color-muted)]">{t("list.nextRun")}</div>
                  <div>
                    {!site.schedule_cron
                      ? t("list.manual")
                      : site.status !== "active"
                        ? t("list.notScheduled")
                        : next
                          ? formatWhen(next.toISOString(), locale)
                          : site.schedule_cron}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <p className="text-sm text-[var(--color-muted)]">{t("list.noneInFilter")}</p> : null}
    </div>
  );
}

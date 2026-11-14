"use client";

import Link from "next/link";

import { Pill } from "@/components/ui/Pill";
import { ChevronRightIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import type { DataSource } from "@/types/data";

import { STATUS_TONE, allows } from "./format";

/** Figma "Data — source list": one row per source with its dictionary status and next step. */
export function DataList({ sources, people }: { sources: DataSource[]; people: Record<string, string> }) {
  const t = useT("data");
  if (sources.length === 0) {
    return (
      <div data-component="DataList" className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center">
        <p className="font-medium">{t("list.emptyTitle")}</p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{t("list.emptyBody")}</p>
      </div>
    );
  }
  return (
    <ul
      data-component="DataList"
      className="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      {sources.map((s) => {
        const status = s.status ?? "not_described";
        const drift = (s.schema_drift?.length ?? 0) > 0;
        const next =
          drift && allows(s.access, "manage")
            ? t("status.drift")
            : status === "draft" && allows(s.access, "manage")
            ? t("list.next.review", { n: s.draft_changes ?? 0 })
            : status === "not_described"
              ? allows(s.access, "propose")
                ? t("list.next.build")
                : t("list.next.none")
              : t("list.next.open");
        return (
          <li key={s.id} data-source={s.id}>
            <Link
              href={status === "draft" && allows(s.access, "manage") ? `/data/${s.id}/review` : `/data/${s.id}`}
              className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-[var(--color-fg)]">{s.name}</span>
                  <Pill tone={STATUS_TONE[status]}>
                    {status === "approved"
                      ? t("status.approved", { v: s.approved_version ?? 0 })
                      : t(`status.${status}`)}
                  </Pill>
                  {drift ? <Pill tone="warning">{t("status.drift")}</Pill> : null}
                </span>
                <span className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                  {t(`kind.${s.kind}`)} · {t("list.described", { n: s.tables_described ?? 0 })} ·{" "}
                  {s.owner_user_id ? t("list.owner", { who: people[s.owner_user_id] ?? s.owner_user_id }) : t("list.ownerAdmins")}
                  {" · "}
                  {t(`access.${s.access}`)}
                </span>
              </span>
              <span className="hidden shrink-0 text-sm text-[var(--color-accent)] sm:inline">{next}</span>
              <ChevronRightIcon size={18} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

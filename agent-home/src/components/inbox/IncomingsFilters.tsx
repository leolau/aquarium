"use client";

import { useState } from "react";

import { TagFilterBar } from "@/components/chat/TagFilterBar";
import { useT } from "@/i18n";
import { FilterIcon } from "@/components/ui/icons";
import { Sheet, primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import type { IncomingsFacets } from "@/types";

export interface IncomingsFilterState {
  q: string;
  surfaces: string[];
  includeTags: string[];
  excludeTags: string[];
  tagMatch: "any" | "all";
  hasAttachments: boolean;
  remembered: boolean | null;
  since: string;
  until: string;
}

export const EMPTY_FILTERS: IncomingsFilterState = {
  q: "",
  surfaces: [],
  includeTags: [],
  excludeTags: [],
  tagMatch: "any",
  hasAttachments: false,
  remembered: null,
  since: "",
  until: "",
};

const SURFACE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  calendar: "Calendar",
  telegram: "Telegram",
  imessage: "iMessage",
  slack: "Slack",
  discord: "Discord",
  agent_home: "Chat",
};

export function surfaceLabel(surface: string): string {
  return SURFACE_LABEL[surface] ?? surface;
}

/**
 * Search box, channel chips, tag chips and a date range over the inbox.
 *
 * The chips are built from the facets, not from a hard-coded channel list: a
 * "Calendar" filter on a box with no calendar arrivals is a control that can
 * only ever disappoint. Tags reuse {@link TagFilterBar} — the same tri-state
 * chips and AND/OR switch as the session list, over the same vocabulary.
 */
export function IncomingsFilters({
  facets,
  value,
  onChange,
}: {
  facets: IncomingsFacets;
  value: IncomingsFilterState;
  onChange: (next: IncomingsFilterState) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const t = useT("inbox");
  const patch = (part: Partial<IncomingsFilterState>) =>
    onChange({ ...value, ...part });

  const toggleSurface = (surface: string) =>
    patch({
      surfaces: value.surfaces.includes(surface)
        ? value.surfaces.filter((s) => s !== surface)
        : [...value.surfaces, surface],
    });

  // Tri-state, matching the session list: none → include → exclude → none.
  const toggleTag = (name: string) => {
    if (value.includeTags.includes(name)) {
      patch({
        includeTags: value.includeTags.filter((t) => t !== name),
        excludeTags: [...value.excludeTags, name],
      });
      return;
    }
    if (value.excludeTags.includes(name)) {
      patch({ excludeTags: value.excludeTags.filter((t) => t !== name) });
      return;
    }
    patch({ includeTags: [...value.includeTags, name] });
  };

  const activeCount =
    value.surfaces.length +
    value.includeTags.length +
    value.excludeTags.length +
    (value.hasAttachments ? 1 : 0) +
    (value.remembered !== null ? 1 : 0) +
    (value.since || value.until ? 1 : 0);
  const panel = (
    <>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {facets.surfaces.map((s) => (
          <Chip
            key={s.value}
            active={value.surfaces.includes(s.value)}
            onClick={() => toggleSurface(s.value)}
          >
            {surfaceLabel(s.value)} · {s.count}
          </Chip>
        ))}
        {facets.surfaces.length > 0 ? (
          <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
        ) : null}
        <Chip
          active={value.hasAttachments}
          onClick={() => patch({ hasAttachments: !value.hasAttachments })}
        >
          Attachments
        </Chip>
        <Chip
          active={value.remembered === true}
          onClick={() =>
            patch({ remembered: value.remembered === true ? null : true })
          }
        >
          Remembered
        </Chip>
      </div>

      <TagFilterBar
        tags={facets.tags}
        includeTags={value.includeTags}
        excludeTags={value.excludeTags}
        matchMode={value.tagMatch}
        onToggle={toggleTag}
        onMatchModeChange={(mode) => patch({ tagMatch: mode })}
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
        <label className="flex items-center gap-1">
          From
          <input
            type="date"
            value={value.since}
            onChange={(e) => patch({ since: e.target.value })}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1">
          To
          <input
            type="date"
            value={value.until}
            onChange={(e) => patch({ until: e.target.value })}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
          />
        </label>
      </div>
    </>
  );

  return (
    <div data-component="IncomingsFilters" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
      <input
        data-component="IncomingsSearch"
        type="search"
        value={value.q}
        onChange={(e) => patch({ q: e.target.value })}
        placeholder="Search everything that arrived"
        className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
        <button
          type="button"
          data-action="open-filters"
          onClick={() => setSheetOpen(true)}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] lg:hidden"
        >
          <FilterIcon size={16} />
          {activeCount ? t("filtersCount", { count: activeCount }) : t("filters")}
        </button>
      </div>
      <div className="hidden flex-col gap-2 lg:flex">{panel}</div>
      {sheetOpen ? (
        <Sheet
          title={t("filters")}
          component="IncomingsFiltersSheet"
          onClose={() => setSheetOpen(false)}
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChange({ ...EMPTY_FILTERS, q: value.q })}
                className={secondaryButtonClass}
              >
                {t("clearAll")}
              </button>
              <button type="button" onClick={() => setSheetOpen(false)} className={primaryButtonClass}>
                {t("showResults")}
              </button>
            </div>
          }
        >
          <div className="flex flex-col gap-3">{panel}</div>
        </Sheet>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      data-component="Chip"
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

/** The filter state as a querystring, for the URL and for the fetch. */
export function filtersToParams(
  value: IncomingsFilterState,
  cursor?: string | null,
): URLSearchParams {
  const p = new URLSearchParams();
  if (value.q.trim()) p.set("q", value.q.trim());
  if (value.surfaces.length) p.set("surface", value.surfaces.join(","));
  if (value.includeTags.length) p.set("tag", value.includeTags.join(","));
  if (value.excludeTags.length) p.set("exclude_tag", value.excludeTags.join(","));
  if (value.tagMatch === "all") p.set("tag_match", "all");
  if (value.hasAttachments) p.set("has_attachments", "true");
  if (value.remembered != null) p.set("remembered", String(value.remembered));
  if (value.since) p.set("since", value.since);
  if (value.until) p.set("until", value.until);
  // The cursor is where *this reader* has scrolled to, not part of the filter;
  // it is passed to the fetch and deliberately kept out of the shared URL.
  if (cursor) p.set("cursor", cursor);
  return p;
}

/** The inverse, so a shared URL restores the filters it described. */
export function filtersFromParams(
  params: URLSearchParams,
): IncomingsFilterState {
  const csv = (key: string) =>
    (params.get(key) ?? "").split(",").filter(Boolean);
  const remembered = params.get("remembered");
  return {
    q: params.get("q") ?? "",
    surfaces: csv("surface"),
    includeTags: csv("tag"),
    excludeTags: csv("exclude_tag"),
    tagMatch: params.get("tag_match") === "all" ? "all" : "any",
    hasAttachments: params.get("has_attachments") === "true",
    remembered: remembered == null ? null : remembered === "true",
    since: params.get("since") ?? "",
    until: params.get("until") ?? "",
  };
}

"use client";

import Link from "next/link";

import { RefBadge } from "@/components/refs/RefBadge";
import type { IncomingItem } from "@/types";

/** A glyph per channel: the fastest way to read a mixed list at a glance. */
const SURFACE_GLYPH: Record<string, string> = {
  whatsapp: "💬",
  email: "✉️",
  calendar: "📅",
  telegram: "✈️",
  imessage: "💬",
  slack: "#",
  discord: "🎮",
  agent_home: "🏠",
};

const TAG_COLOR: Record<string, string> = {
  blue: "var(--color-accent)",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  purple: "#a855f7",
  gray: "var(--color-muted)",
};

export function surfaceGlyph(surface: string): string {
  return SURFACE_GLYPH[surface] ?? "•";
}

/** "2m", "3h", "6 Aug" — absolute dates only once relative stops helping. */
export function relativeWhen(iso: string | null): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const seconds = Math.round((Date.now() - when.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The time range on a meeting: "14:00 – 14:30". */
export function timeRange(item: IncomingItem): string {
  if (!item.occurred_at || !item.ends_at) return "";
  const start = new Date(item.occurred_at);
  const end = new Date(item.ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

/** The first line of the body, for the excerpt under the title. */
export function excerpt(item: IncomingItem, max = 140): string {
  const text = (item.body || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One arrival in the list: what it is, who it came from, and when.
 *
 * The title falls back to the sender because a WhatsApp message has no
 * subject, and "(no subject)" in a list of chat messages would be noise on
 * every row rather than information on any of them.
 */
export function IncomingRow({ item, from = "" }: { item: IncomingItem; from?: string }) {
  const title =
    item.subject?.trim() ||
    item.sender_name?.trim() ||
    item.sender_id?.trim() ||
    "(untitled)";
  const range = item.kind === "event" ? timeRange(item) : "";
  const preview = excerpt(item);

  return (
    <li data-component="IncomingRow">
      <Link
        href={`/inbox/${encodeURIComponent(item.id)}${from ? `?from=${encodeURIComponent(from)}` : ""}`}
        className="block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition hover:border-[var(--color-accent)]"
      >
        <div className="flex items-start gap-2">
          <span aria-hidden className="text-base leading-5">
            {surfaceGlyph(item.surface)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
              <RefBadge value={item.ref} />
              <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                {relativeWhen(item.occurred_at)}
              </span>
            </div>
            {preview ? (
              <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                {preview}
              </p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-muted)]">
              {item.subject && (item.sender_name || item.sender_id) ? (
                <span className="truncate">
                  {item.sender_name || item.sender_id}
                </span>
              ) : null}
              {range ? <span>{range}</span> : null}
              {item.has_attachments ? <span title="Has attachments">📎</span> : null}
              {item.importance && item.importance !== "normal" ? (
                <span className="rounded-full border border-[var(--color-accent)] px-1.5 text-[var(--color-accent)]">
                  {item.importance}
                </span>
              ) : null}
              {item.remembered ? (
                <span className="rounded-full border border-[var(--color-border)] px-1.5">
                  remembered
                </span>
              ) : null}
              {(item.tags ?? []).map((tag) => (
                <span
                  key={tag.id}
                  className="rounded-full px-1.5"
                  style={{
                    border: `1px solid ${TAG_COLOR[tag.color] ?? TAG_COLOR.blue}`,
                    color: TAG_COLOR[tag.color] ?? TAG_COLOR.blue,
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

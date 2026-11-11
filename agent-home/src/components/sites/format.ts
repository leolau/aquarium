/**
 * Pure helpers for the Sites pages (site-to-schema, plan 2026-11-10-001):
 * status tones, design diffs and the schedule presets <-> cron mapping.
 * Hermes runs `schedule_cron` in UTC, so presets convert local wall time.
 */
import type { Tone } from "@/components/ui/Pill";
import type { SiteDesign, SiteStatus } from "@/types/sites";

export const SITE_STATUS_TONE: Record<SiteStatus, Tone> = {
  draft: "muted",
  studying: "accent",
  awaiting_approval: "warning",
  active: "success",
  paused: "muted",
  error: "danger",
};

export const SITE_TABS = ["design", "data", "runs", "sharing", "schedule"] as const;
export type SiteTab = (typeof SITE_TABS)[number];

export function isSiteTab(value: unknown): value is SiteTab {
  return typeof value === "string" && (SITE_TABS as readonly string[]).includes(value);
}

export function runTone(status: string): Tone {
  if (status === "ok") return "success";
  if (status === "partial") return "warning";
  if (status === "error") return "danger";
  if (status === "running") return "accent";
  return "muted";
}

export interface DesignColumn {
  name: string;
  type: string;
  example?: unknown;
}

export interface DesignEntity {
  name: string;
  kind: "fixed" | "variable";
  reason: string;
  key: string[];
  columns: DesignColumn[];
  refresh: { mode?: string; cursor?: string | null; full_every?: string | null };
  question: string | null;
  source?: string;
}

/** The design's entities, tolerating a malformed or partial design. */
export function designEntities(design: SiteDesign | null | undefined): DesignEntity[] {
  const raw = design?.design?.entities;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): DesignEntity[] => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const cols = Array.isArray(o.columns) ? o.columns : [];
    return [
      {
        name: String(o.name ?? ""),
        kind: o.kind === "fixed" ? "fixed" : "variable",
        reason: typeof o.reason === "string" ? o.reason : "",
        key: Array.isArray(o.key) ? o.key.map(String) : typeof o.key === "string" ? [o.key] : [],
        columns: cols.flatMap((c) =>
          c && typeof c === "object"
            ? [{ name: String((c as DesignColumn).name ?? ""), type: String((c as DesignColumn).type ?? "text"), example: (c as DesignColumn).example }]
            : [],
        ),
        refresh: (o.refresh && typeof o.refresh === "object" ? o.refresh : {}) as DesignEntity["refresh"],
        question: typeof o.question === "string" && o.question.trim() ? o.question : null,
        source: typeof o.source === "string" ? o.source : undefined,
      },
    ];
  });
}

/** The design in force and the newest one still waiting for approval. */
export function pickDesigns(designs: SiteDesign[]): { approved: SiteDesign | null; proposed: SiteDesign | null } {
  const sorted = [...designs].sort((a, b) => b.version - a.version);
  const approved = sorted.find((d) => d.status === "approved") ?? null;
  const proposed = sorted.find((d) => d.status === "proposed" && (!approved || d.version > approved.version)) ?? null;
  return { approved, proposed };
}

export type EntityChange = { kind: "new" } | { kind: "columns"; added: string[] } | { kind: "same" };

/** How `entity` differs from the approved design (additive changes only). */
export function entityChange(entity: DesignEntity, approved: DesignEntity[] | null): EntityChange {
  if (!approved) return { kind: "same" };
  const before = approved.find((e) => e.name === entity.name);
  if (!before) return { kind: "new" };
  const had = new Set(before.columns.map((c) => c.name));
  const added = entity.columns.map((c) => c.name).filter((n) => !had.has(n));
  return added.length ? { kind: "columns", added } : { kind: "same" };
}

// -- schedule ---------------------------------------------------------------

export type SchedulePreset =
  | { kind: "off" }
  | { kind: "hours"; every: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "custom"; cron: string };

const DAY_MINUTES = 24 * 60;

function parseTime(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return 0;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `offsetMinutes` is `Date#getTimezoneOffset()` (UTC minus local). */
export function presetToCron(p: SchedulePreset, offsetMinutes: number): string | null {
  switch (p.kind) {
    case "off":
      return null;
    case "hours":
      return `0 */${Math.max(1, Math.min(23, Math.round(p.every)))} * * *`;
    case "custom":
      return p.cron.trim() || null;
    case "daily": {
      const utc = (((parseTime(p.time) + offsetMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
      return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
    }
    case "weekly": {
      const total = p.day * DAY_MINUTES + parseTime(p.time) + offsetMinutes;
      const week = 7 * DAY_MINUTES;
      const utc = ((total % week) + week) % week;
      const day = Math.floor(utc / DAY_MINUTES);
      const rest = utc % DAY_MINUTES;
      return `${rest % 60} ${Math.floor(rest / 60)} * * ${day}`;
    }
  }
}

/** The preset a stored cron came from, or `custom` when it is anything else. */
export function cronToPreset(cron: string | null | undefined, offsetMinutes: number): SchedulePreset {
  const text = (cron ?? "").trim();
  if (!text) return { kind: "off" };
  const hours = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(text);
  if (hours) return { kind: "hours", every: Number(hours[1]) };
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text);
  if (daily) {
    const local = ((Number(daily[2]) * 60 + Number(daily[1]) - offsetMinutes) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
    return { kind: "daily", time: fmtTime(local) };
  }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/.exec(text);
  if (weekly) {
    const week = 7 * DAY_MINUTES;
    const utc = (Number(weekly[3]) % 7) * DAY_MINUTES + Number(weekly[2]) * 60 + Number(weekly[1]);
    const local = (((utc - offsetMinutes) % week) + week) % week;
    return { kind: "weekly", day: Math.floor(local / DAY_MINUTES), time: fmtTime(local % DAY_MINUTES) };
  }
  return { kind: "custom", cron: text };
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const lo = m[1] === "*" ? min : Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : m[1] === "*" || m[3] ? max : lo;
    const step = m[3] ? Number(m[3]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * The next time a 5-field UTC cron fires after `from`, or null when it can't
 * be read here (names, `L`, `#` …) or doesn't fire within 31 days.
 */
export function nextCronRun(cron: string | null | undefined, from: Date): Date | null {
  const fields = (cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = [
    parseField(fields[0], 0, 59),
    parseField(fields[1], 0, 23),
    parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12),
    parseField(fields[4], 0, 7),
  ];
  if (!min || !hour || !dom || !mon || !dow) return null;
  if (dow.has(7)) dow.add(0);
  const domAny = fields[2] === "*";
  const dowAny = fields[4] === "*";
  const t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 31 * DAY_MINUTES; i++, t.setTime(t.getTime() + 60000)) {
    if (!min.has(t.getUTCMinutes()) || !hour.has(t.getUTCHours()) || !mon.has(t.getUTCMonth() + 1)) continue;
    const dayOk =
      domAny && dowAny
        ? true
        : domAny
          ? dow.has(t.getUTCDay())
          : dowAny
            ? dom.has(t.getUTCDate())
            : dom.has(t.getUTCDate()) || dow.has(t.getUTCDay());
    if (dayOk) return new Date(t);
  }
  return null;
}

/** Name for a user id from the colleague directory, else the id itself. */
export function personName(people: Record<string, string>, userId: string | null | undefined): string {
  if (!userId) return "—";
  return people[userId] ?? userId;
}

export function formatWhen(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export async function readError(res: Response): Promise<string> {
  try {
    const doc = (await res.json()) as { detail?: string; error?: string };
    return doc.detail || doc.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** JSON from a Sites BFF route, or an Error carrying the server's message. */
export async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

export const JSON_HEADERS = { "content-type": "application/json" };

export function sitePath(id: string, ...parts: string[]): string {
  return ["/api/sites", encodeURIComponent(id), ...parts.map(encodeURIComponent)].join("/");
}

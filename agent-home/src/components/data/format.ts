/** Pure helpers for the Data pages (data dictionary, plan 2026-11-14-001). */
import type { Tone } from "@/components/ui/Pill";
import type { DataAccess, DictionaryEntries, DictionaryEntry, DictionaryStatus } from "@/types/data";

export const STATUS_TONE: Record<DictionaryStatus, Tone> = {
  approved: "success",
  draft: "warning",
  not_described: "muted",
};

const RANK: Record<DataAccess, number> = { read: 1, propose: 2, manage: 3 };

export function allows(access: DataAccess | undefined, need: DataAccess): boolean {
  return !!access && RANK[access] >= RANK[need];
}

export function dataPath(id: string, ...parts: string[]): string {
  return ["/api/data/sources", encodeURIComponent(id), ...parts.map(encodeURIComponent)].join("/");
}

export const EMPTY_ENTRY: DictionaryEntry = {
  meaning: "",
  row: "",
  grain: "",
  columns: {},
  joins: [],
  metrics: [],
  examples: [],
};

export function entryOf(entries: DictionaryEntries | null | undefined, table: string): DictionaryEntry {
  return { ...EMPTY_ENTRY, ...(entries?.tables?.[table] ?? {}) };
}

/** `name: text` lines <-> the columns map (blank lines and lines without a name are dropped). */
export function columnsToText(columns: Record<string, string>): string {
  return Object.entries(columns)
    .map(([c, d]) => `${c}: ${d}`)
    .join("\n");
}

export function textToColumns(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    const name = (at < 0 ? line : line.slice(0, at)).trim().toLowerCase();
    if (name) out[name] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  return out;
}

/** What a reviewer sees changed in one table, field by field. */
export function fieldDiff(before: DictionaryEntry | null, after: DictionaryEntry | null): { field: string; from: string; to: string }[] {
  const show = (e: DictionaryEntry | null, f: keyof DictionaryEntry): string => {
    if (!e) return "";
    const v = e[f];
    if (typeof v === "string") return v;
    if (f === "columns") return columnsToText(v as Record<string, string>);
    return (v as Record<string, string>[]).map((i) => Object.values(i).filter(Boolean).join(" — ")).join("\n");
  };
  const fields: (keyof DictionaryEntry)[] = ["meaning", "row", "grain", "columns", "joins", "metrics", "examples"];
  return fields.flatMap((f) => {
    const from = show(before, f);
    const to = show(after, f);
    return from === to ? [] : [{ field: f, from, to }];
  });
}

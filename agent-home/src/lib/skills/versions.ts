/**
 * Skill version history (Skills Lab C-2): the shapes the BFF passes through
 * and the pure helpers the Versions tab renders with.
 */

import type { SkillVersionList, SkillVersionMeta } from "@/lib/skills/improve";

export type { SkillVersionList, SkillVersionMeta };
export type VersionStatus = SkillVersionMeta["status"];

export interface SkillVersionDetail {
  meta: SkillVersionMeta;
  content: string;
  files: Array<{ path: string; size: number }>;
}

export interface SkillVersionDiff {
  a: string;
  b: string;
  diff: string;
}

const STATUSES: VersionStatus[] = ["active", "draft", "archived"];

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Only the documented fields reach the browser. */
export function toVersionMeta(raw: unknown): SkillVersionMeta {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = STATUSES.includes(r.status as VersionStatus) ? (r.status as VersionStatus) : "archived";
  const id = text(r.id);
  const n = typeof r.n === "number" ? r.n : Number(id.replace(/^v/, "")) || 0;
  return {
    id,
    n,
    created_at: typeof r.created_at === "number" || typeof r.created_at === "string" ? r.created_at : null,
    author: text(r.author),
    message: text(r.message),
    parent: textOrNull(r.parent),
    status,
    source: text(r.source),
    ...(textOrNull(r.sha256) ? { sha256: text(r.sha256) } : {}),
    trial_of: textOrNull(r.trial_of),
  };
}

export function toVersionList(raw: unknown, fallbackName = ""): SkillVersionList {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name: text(r.name) || fallbackName,
    active: textOrNull(r.active),
    versions: Array.isArray(r.versions) ? r.versions.map(toVersionMeta) : [],
  };
}

/** Newest first. */
export function sortVersions(versions: SkillVersionMeta[]): SkillVersionMeta[] {
  return [...versions].sort((a, b) => b.n - a.n);
}

export function activeVersion(list: SkillVersionList | null): SkillVersionMeta | null {
  if (!list) return null;
  return list.versions.find((v) => v.id === list.active) ?? list.versions.find((v) => v.status === "active") ?? null;
}

/** Default compare pair: active → newest draft, else active → newest other version. */
export function defaultPair(list: SkillVersionList): [string, string] | null {
  const sorted = sortVersions(list.versions);
  const active = activeVersion(list);
  if (!active) return sorted.length > 1 ? [sorted[1].id, sorted[0].id] : null;
  const target = sorted.find((v) => v.status === "draft") ?? sorted.find((v) => v.id !== active.id);
  return target ? [active.id, target.id] : null;
}

/** Compare pair for a picked version: against the active one, or the active one against what it replaced. */
export function pairFor(list: SkillVersionList, id: string): [string, string] | null {
  const active = activeVersion(list);
  if (active && id !== active.id) return [active.id, id];
  const v = list.versions.find((x) => x.id === id);
  if (!v) return null;
  const base = v.trial_of ?? v.parent ?? sortVersions(list.versions).find((x) => x.n < v.n)?.id ?? null;
  return base && base !== id ? [base, id] : null;
}

export function epochOf(when: number | string | null): number | null {
  if (typeof when === "number") return when;
  if (typeof when === "string" && when) {
    const ms = Date.parse(when);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

/** "just now" · "5 min ago" · "3h ago" · "21 Oct". */
export function timeAgo(when: number | string | null, now = Date.now()): string {
  const epoch = epochOf(when);
  if (epoch == null) return "";
  const seconds = now / 1000 - epoch;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  const date = new Date(epoch * 1000);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Who made a version, for people: "agent", "curator", a user id, … */
export function authorLabel(author: string): string {
  if (!author) return "unknown";
  const [kind, ...rest] = author.split(":");
  const id = rest.join(":");
  if (kind === "user") return id || "user";
  if (kind === "agent") return "agent";
  if (kind === "hub") return "skills hub";
  return author;
}

const SOURCE_LABEL: Record<string, string> = {
  improve: "Improve chat",
  patch: "skill_manage patch",
  restore: "restore",
  import: "import",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? "";
}

export type DiffRow =
  | { kind: "file"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "note"; text: string }
  | { kind: "add" | "del" | "same"; text: string; oldNo: number | null; newNo: number | null };

export interface ParsedDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  files: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function fileName(line: string): string {
  const raw = line.slice(4).split("\t")[0].trim();
  return raw.replace(/^[ab]\//, "");
}

/** Parse `diff -u` / `git diff` text into numbered rows. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let oldFile = "";
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0];
      const body = line.slice(1);
      if (mark === "+") {
        rows.push({ kind: "add", text: body, oldNo: null, newNo: newNo++ });
        newLeft--;
        added++;
        continue;
      }
      if (mark === "-") {
        rows.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null });
        oldLeft--;
        removed++;
        continue;
      }
      if (mark === " " || line === "") {
        rows.push({ kind: "same", text: body, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (line.startsWith("\\")) continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("\\") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ")) {
      oldFile = fileName(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      let name = fileName(line);
      if (name === "/dev/null") name = oldFile;
      files.push(name);
      rows.push({ kind: "file", text: name });
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: "hunk", text: hunk[5].trim() });
      continue;
    }
    if (line.trim()) rows.push({ kind: "note", text: line });
  }
  return { rows, added, removed, files };
}

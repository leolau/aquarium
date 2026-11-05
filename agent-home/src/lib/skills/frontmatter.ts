/**
 * SKILL.md frontmatter: read the documented fields and patch them in place.
 *
 * This is deliberately not a general YAML library. It understands the subset
 * skills actually use (plain/quoted/block scalars, flow and block lists,
 * nested mappings) and edits a document by rewriting only the lines of the
 * field that changed, so comments, key order and unknown keys survive a
 * structured edit byte-for-byte. Anything it can't safely rewrite is reported
 * as `unsupported` and left for the plain-text view. The backend's YAML parser
 * (`_validate_frontmatter`) stays the source of truth on save.
 */

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  platforms: string[];
  tags: string[];
  related_skills: string[];
  category: string;
}

export type MetaField = keyof SkillMeta;
export const LIST_FIELDS = ["platforms", "tags", "related_skills"] as const;
type ListField = (typeof LIST_FIELDS)[number];
type ScalarField = Exclude<MetaField, ListField>;

/** The raw pieces of a document; `head + yaml + close + body` is the original text. */
export interface SplitDoc {
  hasFrontmatter: boolean;
  /** Set when the document starts with `---` but the block never closes. */
  unclosed: boolean;
  head: string;
  yaml: string;
  close: string;
  body: string;
}

export interface ParsedSkill {
  split: SplitDoc;
  meta: SkillMeta;
  /** Fields present in a shape the structured form can't rewrite safely. */
  unsupported: MetaField[];
  /** Structural problems the header has (empty when it looks valid). */
  problems: string[];
}

export class UnsupportedFieldError extends Error {}

const FIELD_PATHS: Record<MetaField, string[]> = {
  name: ["name"],
  description: ["description"],
  version: ["version"],
  author: ["author"],
  license: ["license"],
  platforms: ["platforms"],
  tags: ["metadata", "hermes", "tags"],
  related_skills: ["metadata", "hermes", "related_skills"],
  category: ["metadata", "hermes", "category"],
};

/** Hermes also reads these from the top level when `metadata.hermes` lacks them. */
const TOP_LEVEL_FALLBACK: Partial<Record<MetaField, string[]>> = {
  tags: ["tags"],
  related_skills: ["related_skills"],
};

/** Preferred top-level order, used only when a key has to be added. */
const TOP_ORDER = ["name", "description", "version", "author", "license", "platforms", "metadata"];

// ── Splitting ────────────────────────────────────────────────────────────

/** Mirrors `_validate_frontmatter`: starts with `---`, closes at `\n---<ws>\n`. */
export function splitDoc(doc: string): SplitDoc {
  const none = { hasFrontmatter: false, unclosed: false, head: "", yaml: "", close: "", body: doc };
  if (!doc.startsWith("---")) return none;
  const firstBreak = doc.indexOf("\n");
  if (firstBreak < 0 || doc.slice(3, firstBreak).trim() !== "") return { ...none, unclosed: true };
  const m = /\n---[ \t]*\r?\n/.exec(doc.slice(firstBreak)) ?? /\n---[ \t]*$/.exec(doc.slice(firstBreak));
  if (!m) return { ...none, unclosed: true };
  const closeStart = firstBreak + m.index + 1;
  return {
    hasFrontmatter: true,
    unclosed: false,
    head: doc.slice(0, firstBreak + 1),
    yaml: doc.slice(firstBreak + 1, closeStart),
    close: doc.slice(closeStart, closeStart + m[0].length - 1),
    body: doc.slice(closeStart + m[0].length - 1),
  };
}

export function joinDoc(s: SplitDoc): string {
  return s.head + s.yaml + s.close + s.body;
}

/** The Markdown instructions (blank lines right after the header are not shown). */
export function getBody(doc: string): string {
  return splitDoc(doc).body.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function setBody(doc: string, body: string): string {
  const s = splitDoc(doc);
  if (!s.hasFrontmatter) return body;
  const lead = /^(?:[ \t]*\r?\n)*/.exec(s.body)?.[0] ?? "";
  return joinDoc({ ...s, body: lead + body });
}

// ── Line-level YAML reading ──────────────────────────────────────────────

interface Entry {
  key: string;
  /** The key exactly as written (keeps quoting). */
  rawKey: string;
  indent: number;
  start: number;
  /** Exclusive; trailing blank/comment lines are not part of the entry. */
  end: number;
  rest: string;
}

type Value =
  | { kind: "null" }
  | { kind: "scalar"; value: string; style: "plain" | "double" | "single" | "block" }
  | { kind: "list"; items: string[]; style: "flow" | "block"; itemIndent: number }
  | { kind: "map" }
  | { kind: "unsupported" };

const KEY_RE = /^( *)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

const indentOf = (line: string) => line.length - line.replace(/^ +/, "").length;
const isFiller = (line: string) => {
  const t = line.trim();
  return t === "" || t.startsWith("#");
};
const isItem = (t: string) => t === "-" || t.startsWith("- ");

function unquoteKey(raw: string): string {
  if (raw.startsWith('"')) return parseDouble(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function parseEntries(lines: string[], from: number, to: number, indent: number): Entry[] {
  const out: Entry[] = [];
  let i = from;
  while (i < to) {
    const line = lines[i];
    const m = KEY_RE.exec(line);
    if (!m || m[1].length !== indent || isFiller(line)) {
      i++;
      continue;
    }
    let last = i;
    let j = i + 1;
    for (; j < to; j++) {
      const l = lines[j];
      if (isFiller(l)) continue;
      const ind = indentOf(l);
      if (ind > indent || (ind === indent && isItem(l.trimStart()))) last = j;
      else break;
    }
    out.push({ key: unquoteKey(m[2]), rawKey: m[2], indent, start: i, end: last + 1, rest: (m[3] ?? "").trim() });
    i = last + 1;
  }
  return out;
}

/** Lines in [from, to) that are neither entries nor part of one (i.e. junk). */
function strayLines(lines: string[], from: number, to: number, indent: number, entries: Entry[]): number[] {
  const covered = new Set<number>();
  for (const e of entries) for (let k = e.start; k < e.end; k++) covered.add(k);
  const out: number[] = [];
  for (let k = from; k < to; k++) if (!covered.has(k) && !isFiller(lines[k]) && indentOf(lines[k]) <= indent) out.push(k);
  return out;
}

function childIndent(lines: string[], e: Entry): number | null {
  for (let k = e.start + 1; k < e.end; k++) if (!isFiller(lines[k])) return indentOf(lines[k]);
  return null;
}

export function parseDouble(inner: string): string {
  try {
    return JSON.parse(`"${inner.replace(/\t/g, "\\t")}"`) as string;
  } catch {
    return inner.replace(/\\(["\\/])/g, "$1");
  }
}

function stripComment(s: string): string {
  return s.replace(/(^|\s)#.*$/, "").trim();
}

/** Reads a quoted scalar starting at text[0]; returns value + the remainder. */
function readQuoted(text: string): { value: string; rest: string } | null {
  const q = text[0];
  for (let k = 1; k < text.length; k++) {
    if (q === '"' && text[k] === "\\") {
      k++;
      continue;
    }
    if (text[k] === q) {
      if (q === "'" && text[k + 1] === "'") {
        k++;
        continue;
      }
      const raw = text.slice(1, k).replace(/[ \t]*\n[ \t]*/g, " ");
      return { value: q === '"' ? parseDouble(raw) : raw.replace(/''/g, "'"), rest: text.slice(k + 1) };
    }
  }
  return null;
}

function unquoteItem(s: string): string | null {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const r = readQuoted(t);
    return r && r.rest.trim() === "" ? r.value : null;
  }
  if (/^[&*!|>{[]/.test(t)) return null;
  return t;
}

function readFlowList(text: string): string[] | null {
  const items: string[] = [];
  let cur = "";
  for (let k = 1; k < text.length; k++) {
    const c = text[k];
    if (c === '"' || c === "'") {
      const r = readQuoted(text.slice(k));
      if (!r) return null;
      const consumed = text.length - k - r.rest.length;
      cur += text.slice(k, k + consumed);
      k += consumed - 1;
      continue;
    }
    if (c === "[" || c === "{") return null;
    if (c === "," || c === "]") {
      const raw = cur.replace(/\s+/g, " ").trim();
      if (raw) {
        const v = unquoteItem(raw);
        if (v === null) return null;
        items.push(v);
      }
      cur = "";
      if (c === "]") return stripComment(text.slice(k + 1)) === "" ? items : null;
      continue;
    }
    cur += c;
  }
  return null;
}

function readValue(lines: string[], e: Entry): Value {
  const rest = e.rest.startsWith("#") ? "" : e.rest;
  const child = lines.slice(e.start + 1, e.end);
  const content = child.filter((l) => !isFiller(l));
  if (rest === "") {
    if (content.length === 0) return { kind: "null" };
    if (isItem(content[0].trimStart())) {
      const itemIndent = indentOf(content[0]);
      const items: string[] = [];
      for (const l of content) {
        if (indentOf(l) !== itemIndent || !isItem(l.trimStart())) return { kind: "unsupported" };
        const v = unquoteItem(stripCommentKeepQuotes(l.trimStart().slice(1)));
        if (v === null || v === "" || KEY_RE.test(` ${v}`) && /:\s/.test(v)) return { kind: "unsupported" };
        items.push(v);
      }
      return { kind: "list", items, style: "block", itemIndent };
    }
    return { kind: "map" };
  }
  if (/^[|>]/.test(rest)) {
    const header = /^([|>])([+-]?)\d?([+-]?)\s*(#.*)?$/.exec(rest);
    if (!header) return { kind: "unsupported" };
    const ind = content.length ? indentOf(content[0]) : 0;
    const textLines = child.map((l) => l.slice(Math.min(ind, indentOf(l))));
    while (textLines.length && textLines[textLines.length - 1].trim() === "") textLines.pop();
    const value =
      header[1] === "|"
        ? textLines.join("\n")
        : textLines.reduce((acc, l, k) => (k === 0 ? l : l === "" ? `${acc}\n` : acc.endsWith("\n") ? acc + l : `${acc} ${l}`), "");
    return { kind: "scalar", value, style: "block" };
  }
  const joined = [rest, ...child.map((l) => l.trim())].join("\n");
  if (rest.startsWith("[")) {
    const items = readFlowList(joined);
    return items ? { kind: "list", items, style: "flow", itemIndent: e.indent + 2 } : { kind: "unsupported" };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const r = readQuoted(joined);
    if (!r || stripComment(r.rest) !== "") return { kind: "unsupported" };
    return { kind: "scalar", value: r.value, style: rest.startsWith('"') ? "double" : "single" };
  }
  if (/^[{&*!%@`]/.test(rest)) return { kind: "unsupported" };
  const value = [stripComment(rest), ...content.map((l) => stripComment(l))].filter(Boolean).join(" ");
  return { kind: "scalar", value, style: "plain" };
}

function stripCommentKeepQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) return t;
  return stripComment(t);
}

interface Located {
  entry: Entry;
  value: Value;
}

function locate(lines: string[], path: string[]): Located | null {
  let from = 0;
  let to = lines.length;
  let indent = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const entry = parseEntries(lines, from, to, indent).find((e) => e.key === path[depth]);
    if (!entry) return null;
    const value = readValue(lines, entry);
    if (depth === path.length - 1) return { entry, value };
    if (value.kind !== "map") return null;
    from = entry.start + 1;
    to = entry.end;
    indent = childIndent(lines, entry) ?? indent + 2;
  }
  return null;
}

function yamlLines(doc: string): { split: SplitDoc; lines: string[] } {
  const split = splitDoc(doc);
  const lines = split.yaml.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return { split, lines };
}

function pathFor(lines: string[], field: MetaField): string[] {
  const fallback = TOP_LEVEL_FALLBACK[field];
  if (fallback && !locate(lines, FIELD_PATHS[field]) && locate(lines, fallback)) return fallback;
  return FIELD_PATHS[field];
}

// ── Public reading ───────────────────────────────────────────────────────

const EMPTY_META: SkillMeta = {
  name: "",
  description: "",
  version: "",
  author: "",
  license: "",
  platforms: [],
  tags: [],
  related_skills: [],
  category: "",
};

export function isListField(field: MetaField): field is ListField {
  return (LIST_FIELDS as readonly string[]).includes(field);
}

export function parseSkill(doc: string): ParsedSkill {
  const { split, lines } = yamlLines(doc);
  const meta: SkillMeta = { ...EMPTY_META, platforms: [], tags: [], related_skills: [] };
  const unsupported: MetaField[] = [];
  const problems: string[] = [];
  if (!split.hasFrontmatter) {
    problems.push(
      split.unclosed
        ? "The YAML header is not closed — add a line with just `---` after it."
        : "SKILL.md must start with a YAML header (`---`).",
    );
    return { split, meta, unsupported, problems };
  }
  const tabbed = lines.findIndex((l) => /^ *\t/.test(l) && !isFiller(l));
  if (tabbed >= 0) problems.push(`YAML header line ${tabbed + 2} is indented with a tab; use spaces.`);
  const top = parseEntries(lines, 0, lines.length, 0);
  const stray = strayLines(lines, 0, lines.length, 0, top);
  if (stray.length) problems.push(`YAML header line ${stray[0] + 2} isn't a \`key: value\` pair.`);
  const seen = new Set<string>();
  for (const e of top) {
    if (seen.has(e.key)) problems.push(`The YAML header has \`${e.key}\` twice.`);
    seen.add(e.key);
  }

  for (const field of Object.keys(FIELD_PATHS) as MetaField[]) {
    const found = locate(lines, pathFor(lines, field));
    if (!found) {
      if (field !== "name" && field !== "description" && FIELD_PATHS[field].length > 1) {
        // A parent (`metadata`/`hermes`) written in a shape we can't descend into.
        const parent = FIELD_PATHS[field].slice(0, -1);
        for (let d = 1; d <= parent.length; d++) {
          const p = locate(lines, parent.slice(0, d));
          if (p && p.value.kind !== "map" && p.value.kind !== "null") {
            unsupported.push(field);
            break;
          }
        }
      }
      continue;
    }
    const v = found.value;
    if (isListField(field)) {
      if (v.kind === "list") meta[field] = v.items;
      else if (v.kind === "scalar" && v.value) meta[field] = [v.value];
      else if (v.kind !== "null") unsupported.push(field);
      if (v.kind === "scalar" && v.value) unsupported.push(field);
    } else if (v.kind === "scalar") {
      meta[field as ScalarField] = v.value;
    } else if (v.kind === "list") {
      // e.g. `author: [a, b]` — shown joined, editable only as plain text.
      meta[field as ScalarField] = v.items.join(", ");
      unsupported.push(field);
    } else if (v.kind !== "null") {
      unsupported.push(field);
    }
  }
  return { split, meta, unsupported, problems };
}

// ── Writing ──────────────────────────────────────────────────────────────

const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMERIC = /^[-+]?(?:\.inf|\.nan|0x[0-9a-f_]+|0o[0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:e[-+]?\d+)?)$/i;

function needsQuotes(v: string, inFlow: boolean): boolean {
  return (
    v === "" ||
    v !== v.trim() ||
    /[\n\r\t]/.test(v) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ||
    /: |\s#|:$/.test(v) ||
    RESERVED.test(v) ||
    NUMERIC.test(v) ||
    (inFlow && /[,[\]{}]/.test(v))
  );
}

function scalarText(v: string, style: "plain" | "double" | "single" | "block", inFlow = false): string {
  if (style === "single" && !/[\n\r\t]/.test(v)) return `'${v.replace(/'/g, "''")}'`;
  if (style === "double" || needsQuotes(v, inFlow)) return JSON.stringify(v);
  return v;
}

function renderEntry(rawKey: string, indent: number, value: string | string[], prev: Value | null): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (prev?.kind === "list" && prev.style === "block") {
      const itemPad = " ".repeat(prev.itemIndent);
      return [`${pad}${rawKey}:`, ...value.map((v) => `${itemPad}- ${scalarText(v, "plain")}`)];
    }
    return [`${pad}${rawKey}: [${value.map((v) => scalarText(v, "plain", true)).join(", ")}]`];
  }
  const style = prev?.kind === "scalar" && prev.style !== "block" ? prev.style : "plain";
  return [`${pad}${rawKey}: ${scalarText(value, style)}`];
}

function sameValue(v: Value, next: string | string[]): boolean {
  if (Array.isArray(next)) return v.kind === "list" ? v.items.length === next.length && v.items.every((x, k) => x === next[k]) : next.length === 0 && v.kind === "null";
  return v.kind === "scalar" ? v.value === next : next === "" && v.kind === "null";
}

function insertionIndex(entries: Entry[], key: string, from: number): number {
  const order = TOP_ORDER.indexOf(key);
  if (order > 0 && key !== "metadata") {
    for (let k = order - 1; k >= 0; k--) {
      const prev = entries.find((e) => e.key === TOP_ORDER[k]);
      if (prev) return prev.end;
    }
  }
  return entries.length ? entries[entries.length - 1].end : from;
}

/** Returns the mapping's child indent and where to add a child, creating parents as needed. */
function ensureMap(lines: string[], path: string[]): { indent: number; at: number; entries: Entry[] } {
  if (path.length === 0) return { indent: 0, at: lines.length, entries: parseEntries(lines, 0, lines.length, 0) };
  const parent = ensureMap(lines, path.slice(0, -1));
  const key = path[path.length - 1];
  let found = parent.entries.find((e) => e.key === key);
  if (!found) {
    const at = parent.indent === 0 ? insertionIndex(parent.entries, key, 0) : parent.at;
    lines.splice(at, 0, `${" ".repeat(parent.indent)}${key}:`);
    found = { key, rawKey: key, indent: parent.indent, start: at, end: at + 1, rest: "" };
  } else {
    const v = readValue(lines, found);
    if (v.kind !== "map" && v.kind !== "null") throw new UnsupportedFieldError(`\`${path.join(".")}\` isn't a mapping.`);
  }
  const indent = childIndent(lines, found) ?? found.indent + 2;
  return { indent, at: found.end, entries: parseEntries(lines, found.start + 1, found.end, indent) };
}

/**
 * Returns `doc` with one documented field set. Untouched when the value is
 * unchanged; an empty optional value removes the key.
 */
export function setMetaField(doc: string, field: MetaField, value: string | string[]): string {
  const { split, lines } = yamlLines(doc);
  if (!split.hasFrontmatter) throw new UnsupportedFieldError("This SKILL.md has no YAML header.");
  const path = pathFor(lines, field);
  const found = locate(lines, path);
  const next = Array.isArray(value) ? value.map((v) => v.trim()).filter(Boolean) : value;
  if (found) {
    const v = found.value;
    if (v.kind === "unsupported" || v.kind === "map") throw new UnsupportedFieldError(`\`${path.join(".")}\` is written in a form only the plain-text view can edit.`);
    if (sameValue(v, next)) return doc;
    if (isListField(field) !== (v.kind === "list") && v.kind !== "null") throw new UnsupportedFieldError(`\`${path.join(".")}\` is written in a form only the plain-text view can edit.`);
    const empty = Array.isArray(next) ? next.length === 0 : next === "";
    const replacement = empty && field !== "name" && field !== "description" ? [] : renderEntry(found.entry.rawKey, found.entry.indent, next, v);
    lines.splice(found.entry.start, found.entry.end - found.entry.start, ...replacement);
  } else {
    if (Array.isArray(next) ? next.length === 0 : next === "") return doc;
    const parent = ensureMap(lines, path.slice(0, -1));
    const key = path[path.length - 1];
    const at = parent.indent === 0 ? insertionIndex(parent.entries, key, 0) : parent.at;
    lines.splice(at, 0, ...renderEntry(key, parent.indent, next, null));
  }
  const yaml = lines.length ? `${lines.join("\n")}\n` : "";
  return joinDoc({ ...split, yaml });
}

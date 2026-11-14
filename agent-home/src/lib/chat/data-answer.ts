/**
 * An answer from data ends with a fenced `data-answer` block (skill
 * `data-questions`): the source, dictionary version, tables and SQL it used.
 * The block is stripped from the shown text and drives the answer footer.
 */
export interface DataAnswer {
  source_id: string;
  source: string;
  version: number | null;
  tables: string[];
  sql: string;
  question: string;
  undescribed: string[];
}

const BLOCK = /\n?```data-answer[^\n]*\n([\s\S]*?)\n?```\s*$/;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "").slice(0, 20) : [];

export function splitDataAnswer(content: string): { text: string; answer: DataAnswer | null } {
  const m = BLOCK.exec(content);
  if (!m) return { text: content, answer: null };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(m[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: content, answer: null };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { text: content, answer: null };
  }
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
  if (!str("source_id") || !str("sql")) return { text: content, answer: null };
  return {
    text: content.slice(0, m.index).trimEnd(),
    answer: {
      source_id: str("source_id"),
      source: str("source") || str("source_id"),
      version: typeof raw.version === "number" && Number.isInteger(raw.version) ? raw.version : null,
      tables: strings(raw.tables),
      sql: str("sql"),
      question: str("question"),
      undescribed: strings(raw.undescribed),
    },
  };
}

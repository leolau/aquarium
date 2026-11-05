/**
 * The editor holds one string — the whole SKILL.md. The structured view and
 * the plain-text view are two lenses on it, so switching views can't lose an
 * edit: every change goes through `applyEdit` and lands in the same document.
 */
import { setBody, setMetaField, UnsupportedFieldError, type MetaField } from "./frontmatter";

export type SkillEdit =
  | { kind: "body"; body: string }
  | { kind: "field"; field: MetaField; value: string | string[] }
  | { kind: "plain"; doc: string };

export function applyEdit(doc: string, edit: SkillEdit): { doc: string; error: string | null } {
  try {
    if (edit.kind === "plain") return { doc: edit.doc, error: null };
    if (edit.kind === "body") return { doc: setBody(doc, edit.body), error: null };
    return { doc: setMetaField(doc, edit.field, edit.value), error: null };
  } catch (err) {
    if (err instanceof UnsupportedFieldError) return { doc, error: err.message };
    throw err;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

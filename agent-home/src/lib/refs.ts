/**
 * Short refs (FG-36): `P12` project, `T345` project card, `P12-R3` run 3 of
 * P12, `D88` to-do, `M512` inbox message — and, with its PR, `C` chats. The
 * mirror of `hermes_cli/short_refs.py#parse_ref`: case-insensitive, no
 * leading zeros, a run suffix only after a project.
 */
export const REF_KINDS = {
  P: "project",
  T: "card",
  C: "chat",
  D: "todo",
  M: "message",
} as const;

export type RefKind = keyof typeof REF_KINDS;

export interface ParsedRef {
  kind: RefKind;
  num: number;
  runNo: number | null;
  /** Canonical upper-case form: `P12`, `P12-R3`. */
  ref: string;
}

const REF_RE = /^\s*([PTCDM])([1-9][0-9]{0,8})(?:-R([1-9][0-9]{0,8}))?\s*$/i;

export function parseRef(text: string | null | undefined): ParsedRef | null {
  const m = REF_RE.exec(text ?? "");
  if (!m) return null;
  const kind = m[1].toUpperCase() as RefKind;
  const runNo = m[3] ? Number(m[3]) : null;
  if (runNo !== null && kind !== "P") return null;
  const num = Number(m[2]);
  return { kind, num, runNo, ref: runNo === null ? `${kind}${num}` : `${kind}${num}-R${runNo}` };
}

/** The agent-home address that opens whatever `ref` names. */
export function refHref(ref: string): string {
  return `/go/${encodeURIComponent(ref)}`;
}

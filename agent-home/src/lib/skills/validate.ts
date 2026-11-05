/** Client-side checks shown in the editor's validation bar (the backend re-checks on save). */
import { getBody, parseSkill } from "./frontmatter";

/** Mirrors `tools/skill_manager_tool.py` (MAX_DESCRIPTION_LENGTH / MAX_SKILL_CONTENT_CHARS). */
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_CHARS = 100_000;

export type CheckLevel = "ok" | "warn" | "error";
export interface Check {
  level: CheckLevel;
  text: string;
}

const WHEN_HINT = /\b(when|whenever|if|use (?:it|this)? ?(?:for|to|on|with)|before|after|for (?:any|every))\b/i;

export function unclosedFence(body: string): boolean {
  let open: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === "") open = null;
  }
  return open !== null;
}

export function validateSkill(doc: string, expectedName: string): Check[] {
  const checks: Check[] = [];
  const { meta, problems, split } = parseSkill(doc);
  if (problems.length) for (const text of problems) checks.push({ level: "error", text });
  else checks.push({ level: "ok", text: "YAML header valid" });
  if (!split.hasFrontmatter) return checks;

  if (!meta.name.trim()) checks.push({ level: "error", text: "The header needs a `name`." });
  else if (meta.name.trim() !== expectedName) checks.push({ level: "error", text: `\`name\` must stay \`${expectedName}\` (renaming isn't supported here).` });

  const description = meta.description.trim();
  if (!description) checks.push({ level: "error", text: "The header needs a `description`." });
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    checks.push({ level: "error", text: `Description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}.` });
  else if (!WHEN_HINT.test(description)) checks.push({ level: "warn", text: "Description says what it does, not when to use it" });
  else checks.push({ level: "ok", text: "Description says when to use it" });

  if (meta.version && !/^\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?$/.test(meta.version.trim()))
    checks.push({ level: "warn", text: "Version isn't in the usual 1.2.3 form" });

  const body = getBody(doc);
  if (!body.trim()) checks.push({ level: "error", text: "Instructions can't be empty." });
  else if (unclosedFence(body)) checks.push({ level: "warn", text: "A code block isn't closed (missing ```)" });
  else checks.push({ level: "ok", text: "Markdown OK" });

  if (doc.length > MAX_SKILL_CONTENT_CHARS)
    checks.push({ level: "error", text: `SKILL.md is ${doc.length.toLocaleString("en")} characters; the limit is ${MAX_SKILL_CONTENT_CHARS.toLocaleString("en")}.` });
  return checks;
}

export const hasErrors = (checks: Check[]) => checks.some((c) => c.level === "error");

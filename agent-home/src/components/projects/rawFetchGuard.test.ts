/**
 * Safety net: every project write goes through `useProjectAction` (sync
 * lock, pending until the refresh lands, Idempotency-Key, retry with the
 * same key). A raw `fetch(…, { method: "POST" })` in a project component
 * bypasses all of that, so this test fails on any new one.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Files still allowed a raw mutating fetch, and why. Keep this short — every
 * entry is a place where a double click can act twice.
 */
const ALLOW_LIST: Record<string, string> = {
  // Owned by parallel redesign workstreams, migrating their own writes.
  "NewProjectForm.tsx": "not in the safety workstream — project creation flow",
  // FormData upload with progress, which the JSON hook does not send. It still
  // sends an Idempotency-Key and its callers hold a useProjectAction-style lock.
  "inputs/uploadProjectFile.ts": "FormData upload fallback when XHR is unavailable",
};

const MUTATING_LITERAL = /\bmethod\s*:\s*(["'`])(POST|PATCH|PUT|DELETE)\1/i;
const SAFE_LITERAL = /\bmethod\s*:\s*(["'`])(GET|HEAD)\1/i;
const ANY_METHOD = /\bmethod\b\s*[:,}]/;

/** The argument text of the call whose `(` sits at `open`, skipping strings. */
function callArgs(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/**
 * 1-based line numbers of raw `fetch(` calls that write: a literal
 * POST/PATCH/PUT/DELETE method, or a method we can't read statically.
 */
export function mutatingFetchLines(source: string): number[] {
  const lines: number[] = [];
  const re = /(?<![\w.$])fetch\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const args = callArgs(source, m.index + m[0].length - 1);
    const writes =
      MUTATING_LITERAL.test(args) || (ANY_METHOD.test(args) && !SAFE_LITERAL.test(args));
    if (writes) lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

function sourceFiles(dir: string, rel = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(path.join(dir, entry.name), relPath);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [relPath];
  });
}

describe("mutatingFetchLines", () => {
  it("flags literal writes and dynamic methods, not reads", () => {
    const src = [
      'await fetch("/a");',
      'await fetch(`/b/${x}`, { cache: "no-store" });',
      'await fetch("/c", { method: "POST" });',
      "await fetch(`/d/${encodeURIComponent(id)}`, {",
      '  method: "DELETE",',
      "});",
      'await fetch("/e", { method: "GET" });',
      "await fetch(path, { method: verb });",
      'await fetch("/f (draft)", { headers: {}, method: \'patch\' });',
      'await fetchImpl("/g", { method: "POST" });',
      'await api.fetch("/h", { method: "PUT" });',
    ].join("\n");
    expect(mutatingFetchLines(src)).toEqual([3, 4, 8, 9]);
  });
});

describe("project components never write with a raw fetch", () => {
  const files = sourceFiles(ROOT);

  it("finds the project components", () => {
    expect(files).toContain("ProjectDetailView.tsx");
    expect(files).toContain("panels/RunsPanel.tsx");
  });

  it("routes every write outside the allow-list through useProjectAction", () => {
    const offenders = files
      .filter((file) => !(file in ALLOW_LIST))
      .flatMap((file) =>
        mutatingFetchLines(readFileSync(path.join(ROOT, file), "utf8")).map(
          (line) => `${file}:${line}`,
        ),
      );
    expect(
      offenders,
      "Use useProjectAction()/ActionButton (see useProjectAction.ts) instead of a raw fetch write",
    ).toEqual([]);
  });

  it("covers the FG-33 Tools page components too", () => {
    const toolsRoot = path.join(ROOT, "..", "tools");
    const toolFiles = sourceFiles(toolsRoot);
    expect(toolFiles).toContain("ToolActionsSheet.tsx");
    const offenders = toolFiles.flatMap((file) =>
      mutatingFetchLines(readFileSync(path.join(toolsRoot, file), "utf8")).map(
        (line) => `tools/${file}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the allow-list honest — drop an entry once its file is migrated", () => {
    const stale = Object.keys(ALLOW_LIST).filter(
      (file) =>
        !files.includes(file) ||
        mutatingFetchLines(readFileSync(path.join(ROOT, file), "utf8")).length === 0,
    );
    expect(stale).toEqual([]);
  });
});

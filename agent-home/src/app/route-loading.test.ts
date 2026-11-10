import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname);

/**
 * Routes allowed to fall back to an ancestor's loading.tsx, with why. Anything
 * else must ship its own, so a tap never leaves the previous page frozen (or
 * the generic root loader) while the server waits on the backend.
 */
const INHERITS: Record<string, string> = {
  "": "root page: app/loading.tsx is its own",
  members: "redirects to /users without a backend call",
  "activate/[...link]": "signed-out; activate/loading.tsx",
  "survey/[token]": "signed-out; survey/loading.tsx",
  "settings/[section]": "title comes from the param; settings/loading.tsx",
};

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api") continue;
      out.push(...pages(full));
    } else if (name === "page.tsx") {
      out.push(relative(APP, dir));
    }
  }
  return out;
}

describe("route loading states", () => {
  const routes = pages(APP).filter((r) => !(r in INHERITS));

  it.each(routes)("/%s has its own loading.tsx", (route) => {
    expect(existsSync(join(APP, route, "loading.tsx"))).toBe(true);
  });

  it.each([
    ["files", "FilesArrivedSkeleton"],
    ["files/browse", "FilesBrowseSkeleton"],
    ["files/bridge", "FolderBridgeSkeleton"],
    ["graph", "GraphSkeleton"],
  ])("/%s loads with a skeleton in its own layout (%s), tabs and header", (route, skeleton) => {
    const src = readFileSync(join(APP, route, "loading.tsx"), "utf8");
    expect(src).toContain(`<${skeleton}`);
    expect(src).toMatch(/<MobileShell[\s\S]*\bwide\b/);
    if (route.startsWith("files")) expect(src).toContain("<FilesTabs");
  });
});

/**
 * The upload routes stay out of the middleware matcher (Next 15.5 races the
 * request body there) and every handler on them runs `guardBodyRoute` itself,
 * so no FG-33 / role check is lost. Reads the sources: importing the
 * middleware pulls `server-only` modules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BODY_ROUTES } from "@/lib/http/body-route-guard";

const src = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

function matcher(): RegExp {
  const m = /matcher:\s*\[\s*"([^"]+)"/.exec(src("middleware.ts"));
  if (!m) throw new Error("matcher not found");
  return new RegExp(`^${m[1]}$`);
}

const sample = (route: string) => route.replace("[slug]", "demo");

describe("middleware matcher", () => {
  it.each(BODY_ROUTES)("does not run on %s", (route) => {
    expect(matcher().test(sample(route))).toBe(false);
    expect(matcher().test(`${sample(route)}/`)).toBe(false);
  });

  it.each([
    "/",
    "/chat",
    "/api/chat/stream",
    "/api/chat/upload-status",
    "/api/chat/upload/extra",
    "/api/projects/demo/files",
    "/api/files/import-history",
    "/api/files",
    "/projects/demo/files/upload",
  ])("still runs on %s", (path) => {
    expect(matcher().test(path)).toBe(true);
  });

  it.each(BODY_ROUTES)("every handler of %s calls guardBodyRoute first", (route) => {
    const code = src(`app${route}/route.ts`);
    const handlers = [...code.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)];
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      const body = code.slice(h.index!, code.indexOf("\n}\n", h.index!));
      expect(body, `${h[1]} ${route}`).toMatch(/^[^]*?\{\s*(\/\/[^\n]*\n\s*)*const denied = await guardBodyRoute\(request\);/);
    }
  });
});

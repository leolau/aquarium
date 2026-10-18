import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config.mjs";
// @ts-expect-error -- Next ships its route matcher without type declarations.
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";

import {
  baselineSecurityHeaders,
  PAGE_HEADERS_SOURCE,
  pageContentSecurityPolicy,
} from "./security-headers.mjs";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe("page CSP", () => {
  const csp = directives(pageContentSecurityPolicy());

  it("blocks framing by other sites, plugins, base-tag and off-site form posts", () => {
    expect(csp.get("frame-ancestors")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
  });

  it("only loads scripts from this origin (plus Next's inline bootstrap)", () => {
    const scripts = csp.get("script-src") ?? [];
    expect(scripts).toContain("'self'");
    expect(scripts.some((s) => s === "*" || s.startsWith("http") || s === "'unsafe-eval'")).toBe(false);
  });

  it("keeps fetch and WebSockets on this origin", () => {
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
  });
});

describe("next.config headers()", () => {
  async function headersFor(source: string) {
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    return rules.filter((r) => r.source === source).flatMap((r) => r.headers);
  }

  it("applies the baseline to every path", async () => {
    const all = await headersFor("/:path*");
    const keys = all.map((h) => h.key);
    for (const { key } of baselineSecurityHeaders()) expect(keys).toContain(key);
    expect(keys).toContain("X-Content-Type-Options");
  });

  it("puts the page CSP on pages but never on /api (it would replace the file sandbox CSP)", async () => {
    const page = await headersFor(PAGE_HEADERS_SOURCE);
    expect(page.map((h) => h.key)).toEqual(["Content-Security-Policy"]);
    expect((await headersFor("/:path*")).map((h) => h.key)).not.toContain("Content-Security-Policy");
    const re = pathToRegexp(PAGE_HEADERS_SOURCE);
    for (const path of ["/", "/chat", "/login", "/projects/acme/cards/1", "/apiary"]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ["/api/files/f1/content", "/api/chat/media/content", "/api/projects/a/artifacts/b/content"]) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it("lists the baseline before the activation rule so no-referrer still wins there", async () => {
    const rules = (await nextConfig.headers!()) as { source: string }[];
    const sources = rules.map((r) => r.source);
    expect(sources.indexOf("/:path*")).toBeLessThan(sources.indexOf("/activate/:path*"));
    const activate = await headersFor("/activate/:path*");
    expect(activate.find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
  });

  it("keeps the first-run /setup page out of referrers, caches and search indexes", async () => {
    const rules = (await nextConfig.headers!()) as { source: string }[];
    const sources = rules.map((r) => r.source);
    expect(sources.indexOf("/:path*")).toBeLessThan(sources.indexOf("/setup"));
    const setup = await headersFor("/setup");
    expect(setup.find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
    expect(setup.find((h) => h.key === "Cache-Control")?.value).toContain("no-store");
  });
});

import { readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { APP_STRIPPED_RESPONSE_HEADERS, appResponseHeaders } from "@/lib/apps/headers";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";

function cspMap(value: string): Map<string, string[]> {
  return new Map(
    value.split(";").map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("app response headers", () => {
  const origin = "https://home.example.com";
  const csp = cspMap(
    appResponseHeaders(origin, "notes", "prod").find((h) => h.key === "Content-Security-Policy")!
      .value,
  );
  const own = ["https://home.example.com/apps/notes", "https://home.example.com/apps/notes/"];

  it("pins fetches, scripts, forms and workers to the app's own path", () => {
    for (const d of ["default-src", "connect-src", "form-action", "worker-src", "manifest-src"]) {
      expect(csp.get(d), d).toEqual(own);
    }
    expect(csp.get("script-src")?.slice(0, 2)).toEqual(own);
    for (const sources of csp.values()) {
      expect(sources).not.toContain("'self'");
      expect(sources).not.toContain("https:");
    }
  });

  it("forbids framing in both directions and base/object tricks", () => {
    for (const d of ["frame-ancestors", "frame-src", "child-src", "object-src", "base-uri"]) {
      expect(csp.get(d), d).toEqual(["'none'"]);
    }
  });

  it("allows eval in neither mode (dev is a built release too, not `next dev`)", () => {
    const devCsp = appResponseHeaders(origin, "notes", "dev")[0].value;
    expect(devCsp).toContain("https://home.example.com/apps-dev/notes/");
    expect(devCsp).not.toContain("'unsafe-eval'");
    expect(csp.get("script-src")).not.toContain("'unsafe-eval'");
  });

  it("severs window.opener between app and agent-home pages", () => {
    const coop = appResponseHeaders(origin, "notes", "prod").find(
      (h) => h.key === "Cross-Origin-Opener-Policy",
    );
    expect(coop?.value).toBe("noopener-allow-popups");
  });
});

describe("Caddyfile.agent-home instance example", () => {
  const caddyfile = readFileSync(
    path.resolve(__dirname, "../../../deploy/Caddyfile.agent-home"),
    "utf8",
  );
  const example = caddyfile
    .split("# --- begin apps.d instance example")[1]
    .split("# --- end apps.d instance example")[0]
    .split("\n")
    .map((l) => l.replace(/^#\s?/, "").trim())
    .join("\n");

  it("imports the per-instance blocks and 404s unrouted app paths", () => {
    expect(caddyfile).toContain("import /etc/caddy/apps.d/*.caddy");
    expect(caddyfile).toMatch(/handle \/api\/apps\/auth\* \{\s*respond "Not found" 404/);
  });

  it("strips the forged principal, then forward_auths, then strips the session cookie", () => {
    const strip = example.indexOf("request_header -X-Aquarium-Principal");
    const auth = example.indexOf("forward_auth 127.0.0.1:3100");
    const cookie = example.indexOf("request_header Cookie");
    const proxy = example.indexOf("reverse_proxy");
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(auth);
    expect(auth).toBeLessThan(cookie);
    expect(cookie).toBeLessThan(proxy);
    expect(example).toContain("route {");
    expect(example).toContain("uri /api/apps/auth");
    expect(example).toContain('header_up X-Aquarium-App "example/prod"');
    expect(example).toContain("copy_headers X-Aquarium-Principal");
  });

  // Caddy's regexes are RE2; these patterns are plain enough for JS to match the same.
  const caddyRegex = (directive: string) =>
    new RegExp(example.match(new RegExp(`${directive} "([^"]+)"`))![1].replace("(?i)", ""), "i");

  it("strips the session cookie under both names and keeps every other cookie", () => {
    const strip = caddyRegex("request_header Cookie");
    for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      const header = `theme=dark; ${name}=abc.def; app_pref=1`;
      expect(header.replace(new RegExp(strip, "g"), ""), name).toBe("theme=dark; app_pref=1");
      expect(`${name}=abc.def`.replace(strip, "")).toBe("");
    }
    expect("x__Host-agent_home_sessionx=1".replace(strip, "")).toBe("x__Host-agent_home_sessionx=1");
  });

  it("refuses an app response that sets the session cookie under either name", () => {
    const setCookie = caddyRegex("Set-Cookie");
    for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      expect(setCookie.test(`${name}=forged; Path=/; Secure`), name).toBe(true);
    }
    expect(setCookie.test("app_pref=1; Path=/apps/example")).toBe(false);
  });

  it("sets exactly the headers headers.ts defines and drops the origin-wide ones", () => {
    for (const { key, value } of appResponseHeaders("https://{host}", "example", "prod")) {
      expect(example).toContain(`${key} "${value}"`);
    }
    for (const key of APP_STRIPPED_RESPONSE_HEADERS) expect(example).toContain(`-${key}`);
  });
});

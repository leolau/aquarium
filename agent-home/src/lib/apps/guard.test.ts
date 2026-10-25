import { describe, expect, it } from "vitest";

import { guardAgentHomeRequest, guardAppRequest, isPublicApiRoute } from "@/lib/apps/guard";
import { parseAppPath } from "@/lib/apps/paths";

const HOST = "home.example.com";

function headers(h: Record<string, string>): Headers {
  return new Headers({ host: HOST, ...h });
}

const fromPage = (path: string, extra: Record<string, string> = {}) =>
  headers({
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: `https://${HOST}${path}`,
    ...extra,
  });

const navigationFrom = (path: string | null) =>
  headers({
    "sec-fetch-site": path ? "same-origin" : "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    ...(path ? { referer: `https://${HOST}${path}` } : {}),
  });

describe("guardAgentHomeRequest: agent-home refuses app pages", () => {
  it("refuses agent-home API calls made from an app page (prod or dev)", () => {
    for (const page of ["/apps/notes/", "/apps-dev/notes/board"]) {
      expect(guardAgentHomeRequest("GET", "/api/tools", fromPage(page)).ok).toBe(false);
      expect(guardAgentHomeRequest("POST", "/api/session/logout", fromPage(page)).ok).toBe(false);
    }
  });

  it("refuses an app page framing agent-home but lets the person navigate back", () => {
    const frame = fromPage("/apps/notes/", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" });
    expect(guardAgentHomeRequest("GET", "/tools", frame).ok).toBe(false);
    expect(guardAgentHomeRequest("GET", "/tools", navigationFrom("/apps/notes/")).ok).toBe(true);
  });

  it("refuses same-origin API calls with the Referer suppressed, except public routes", () => {
    const noReferer = headers({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" });
    expect(guardAgentHomeRequest("GET", "/api/tools", noReferer).ok).toBe(false);
    expect(guardAgentHomeRequest("POST", "/api/auth/invitations/redeem", noReferer).ok).toBe(true);
    expect(guardAgentHomeRequest("POST", "/api/seminar/survey/submit", noReferer).ok).toBe(true);
  });

  it("leaves agent-home's own traffic and non-browser callers alone", () => {
    expect(guardAgentHomeRequest("GET", "/api/tools", fromPage("/tools")).ok).toBe(true);
    expect(guardAgentHomeRequest("GET", "/api/tools", fromPage("/sw.js")).ok).toBe(true);
    expect(guardAgentHomeRequest("GET", "/", navigationFrom(null)).ok).toBe(true);
    expect(guardAgentHomeRequest("GET", "/api/notifications/config", headers({})).ok).toBe(true);
    // A Referer from some other host's /apps page is not one of ours.
    const elsewhere = headers({ "sec-fetch-site": "cross-site", referer: "https://other.test/apps/x/" });
    expect(guardAgentHomeRequest("GET", "/api/tools", elsewhere).ok).toBe(true);
  });

  it("lets the forward_auth subrequest through with the app page's headers", () => {
    expect(guardAgentHomeRequest("GET", "/api/apps/auth", fromPage("/apps/notes/")).ok).toBe(true);
  });
});

describe("guardAppRequest: one app's page cannot drive another app", () => {
  const notes = parseAppPath("/apps/notes/")!;

  it("allows the app's own subresources and any top-level navigation", () => {
    expect(guardAppRequest(notes, fromPage("/apps/notes/board")).ok).toBe(true);
    expect(guardAppRequest(notes, navigationFrom("/apps/other/")).ok).toBe(true);
    expect(guardAppRequest(notes, navigationFrom("/tools")).ok).toBe(true);
    expect(guardAppRequest(notes, navigationFrom(null)).ok).toBe(true);
  });

  it("refuses subresource requests from another app, its dev build, or agent-home", () => {
    for (const page of ["/apps/other/", "/apps/notes2/", "/apps-dev/notes/", "/tools"]) {
      expect(guardAppRequest(notes, fromPage(page)).ok, page).toBe(false);
    }
    const noReferer = headers({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
    expect(guardAppRequest(notes, noReferer).ok).toBe(false);
    const crossSite = headers({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
    expect(guardAppRequest(notes, crossSite).ok).toBe(false);
  });
});

describe("isPublicApiRoute", () => {
  it("follows route-roles.json, including dynamic segments", () => {
    expect(isPublicApiRoute("post", "/api/session/login")).toBe(true);
    expect(isPublicApiRoute("GET", "/api/session/login")).toBe(false);
    expect(isPublicApiRoute("GET", "/api/tools")).toBe(false);
  });
});

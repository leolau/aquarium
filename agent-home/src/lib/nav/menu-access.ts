/**
 * Per-role menu visibility (Settings → Menu) — the pure, SSR/middleware-safe
 * half. The stored lists live in the default profile's config.yaml
 * (`agent_home.nav.roles.<role>.hidden`, owned by `hermes_cli/agent_home_nav.py`).
 *
 * Hiding an app does two things for the roles it is hidden from:
 *   1. the Coral launcher drops its tile (`buildCoralLayout({ hidden })`);
 *   2. the URLs below are refused (middleware): pages render the friendly
 *      "not available for your role" screen, BFF `/api/*` routes answer 403.
 *
 * `APP_URLS` is the ONE place that maps an app id to what it blocks. A page or
 * API prefix is only listed when nothing *else* that stays visible needs it,
 * so deep links keep working:
 *   - chat:      only `/chat`; `/api/chat/*` also serves the lead-chat button
 *                and the status strip on every page.
 *   - inbox:     only the `/inbox` list; `/inbox/<id>` is linked from to-dos.
 *   - projects:  only the `/projects` list + `/projects/new`; project pages
 *                (`/projects/<slug>/…`) are linked from chat, to-dos and
 *                activity, and every `/api/projects*` route serves them.
 *   - memory:    `/api/memory/rows` stays (project memory picker).
 *   - files:     `/api/files/*` stays (inbox attachments, app icons, project
 *                files); only the folder browser API is blocked.
 *   - models:    only Models-page reads; `/api/models/{options,set,…}` stay
 *                (the model picker on Get ready).
 *   - users:     `/api/comms/members` stays (Settings → Telegram, Get ready).
 *   - onboarding: `/api/get-ready` stays (Settings → Get ready).
 * Matching is by path segment: "/inbox" matches "/inbox" only when `exact`,
 * otherwise "/inbox" and "/inbox/…", never "/inboxes".
 */

/** Roles with an editable list. The owner always sees every item. */
export const NAV_ROLES = ["admin", "member", "viewer"] as const;
export type NavRole = (typeof NAV_ROLES)[number];

/** Locked visible for every role, so nobody can lock themselves out. */
export const LOCKED_APP_IDS: readonly string[] = ["home", "settings"];

type UrlRule = { path: string; exact?: boolean };

interface AppUrls {
  pages: UrlRule[];
  apis: UrlRule[];
}

export const APP_URLS: Record<string, AppUrls> = {
  todos: { pages: [{ path: "/todos" }], apis: [{ path: "/api/todos" }] },
  chat: { pages: [{ path: "/chat" }], apis: [] },
  inbox: {
    pages: [{ path: "/inbox", exact: true }],
    apis: [
      { path: "/api/incomings", exact: true },
      { path: "/api/incomings/facets" },
    ],
  },
  memory: {
    pages: [{ path: "/memory" }],
    apis: [{ path: "/api/memory/projection" }, { path: "/api/memory/query" }],
  },
  projects: {
    pages: [{ path: "/projects", exact: true }, { path: "/projects/new" }],
    apis: [],
  },
  files: { pages: [{ path: "/files" }], apis: [{ path: "/api/browse" }] },
  activity: { pages: [{ path: "/activity" }], apis: [] },
  graph: { pages: [{ path: "/graph" }], apis: [] },
  capacity: { pages: [{ path: "/capacity" }], apis: [] },
  users: {
    pages: [{ path: "/users" }, { path: "/members" }],
    apis: [{ path: "/api/comms/directory" }],
  },
  suggestions: {
    pages: [{ path: "/profiles/suggestions" }],
    apis: [{ path: "/api/profiles/suggestions" }],
  },
  tools: { pages: [{ path: "/tools" }], apis: [{ path: "/api/tools/apps" }] },
  models: {
    pages: [{ path: "/models" }],
    apis: [
      { path: "/api/models/overview" },
      { path: "/api/models/performance" },
      { path: "/api/models/pinned" },
      { path: "/api/models/refresh-keys" },
    ],
  },
  core: { pages: [{ path: "/core" }], apis: [] },
  webview: { pages: [{ path: "/webview" }], apis: [{ path: "/api/webview" }] },
  onboarding: { pages: [{ path: "/onboarding" }], apis: [] },
};

/** Path the middleware rewrites a hidden page to. */
export const NOT_AVAILABLE_PATH = "/not-available";

function matches(pathname: string, rule: UrlRule): boolean {
  if (pathname === rule.path) return true;
  return !rule.exact && pathname.startsWith(`${rule.path}/`);
}

/**
 * The hidden app that owns `pathname`, or null when the path stays reachable.
 * Locked apps are never returned, whatever `hidden` says.
 */
export function blockedAppForPath(
  pathname: string,
  hidden: readonly string[],
): { app: string; kind: "page" | "api" } | null {
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  for (const app of hidden) {
    if (LOCKED_APP_IDS.includes(app)) continue;
    const urls = APP_URLS[app];
    if (!urls) continue;
    const rules = isApi ? urls.apis : urls.pages;
    if (rules.some((r) => matches(pathname, r))) {
      return { app, kind: isApi ? "api" : "page" };
    }
  }
  return null;
}

/** Whether `principal` is the owner (who always sees every item). */
export function seesEverything(principal: { role: string; is_owner?: boolean }): boolean {
  return Boolean(principal.is_owner) || principal.role === "owner";
}

/** Drop locked and duplicate ids — defence in depth over the server's validation. */
export function sanitizeHidden(hidden: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const id of hidden) {
    if (typeof id === "string" && !LOCKED_APP_IDS.includes(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** Every app that has URLs to refuse when hidden. */
export const ROLE_GATED_APPS: readonly string[] = Object.keys(APP_URLS);

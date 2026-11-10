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
 *   - profiles:  only the `/profiles` page; `/profiles/suggestions` belongs to
 *                Suggestions, and `/api/chat/profiles` serves the chat picker.
 * Matching is by path segment: "/inbox" matches "/inbox" only when `exact`,
 * otherwise "/inbox" and "/inbox/…", never "/inboxes".
 */

/** Roles with an editable list. Only the owner may change the owner's list. */
export const NAV_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type NavRole = (typeof NAV_ROLES)[number];

/** Locked visible for every role, so nobody can lock themselves out. */
export const LOCKED_APP_IDS: readonly string[] = ["home", "settings"];

/**
 * Locked hidden for members and viewers: everything on these pages is an
 * owner/admin change (the BFF and Python both refuse anyone else), so showing
 * them would only show a page of refusals. Admins see them unless hidden.
 */
export const ADMIN_ONLY_APP_IDS: readonly string[] = ["profiles", "skills"];
export const ADMIN_ONLY_ROLES: readonly string[] = ["member", "viewer"];

/** Whether `appId` is locked off for `role` (cannot be turned on). */
export function isLockedOff(role: string, appId: string): boolean {
  return ADMIN_ONLY_ROLES.includes(role) && ADMIN_ONLY_APP_IDS.includes(appId);
}

/** `hidden` plus the admin-only apps when `role` is a member or viewer. */
export function withAdminOnly(role: string, hidden: readonly string[]): string[] {
  const out = [...hidden];
  if (ADMIN_ONLY_ROLES.includes(role)) {
    for (const id of ADMIN_ONLY_APP_IDS) if (!out.includes(id)) out.push(id);
  }
  return out;
}

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
  profiles: {
    pages: [{ path: "/profiles", exact: true }],
    apis: [{ path: "/api/profiles", exact: true }, { path: "/api/profiles/named" }],
  },
  skills: { pages: [{ path: "/skills" }], apis: [{ path: "/api/skills" }] },
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

/**
 * The path a request can reach, for matching only: percent-decoded (until
 * stable), repeated slashes collapsed, `.`/`..` resolved and a trailing slash
 * dropped — so `/todos/`, `//todos`, `/%74odos` and `/a/../todos` all match
 * `/todos`. Over-matching an unroutable path is harmless; under-matching is a
 * bypass.
 */
export function normalizePath(pathname: string): string {
  let path = pathname;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = new URL(path, "http://n").pathname;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

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
  pathname = normalizePath(pathname);
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

/** The menu list that applies to `principal`: the owner's list for the owner. */
export function navRoleOf(principal: { role: string; is_owner?: boolean }): string {
  return principal.is_owner || principal.role === "owner" ? "owner" : principal.role;
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

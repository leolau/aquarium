/**
 * Logical-parent navigation for inner pages (owner decision: Back always goes
 * to the logical parent, never browser history; desktop shows the trail as a
 * breadcrumb). Pure so it can be unit-tested and used on server or client.
 */
export interface Crumb {
  label: string;
  href: string;
}

interface RouteNode {
  /** Path pattern; `:x` matches exactly one segment. */
  pattern: string;
  label: string;
  /** Parent pattern; omitted for Home. */
  parent?: string;
}

const ROUTES: RouteNode[] = [
  { pattern: "/", label: "Home" },
  { pattern: "/chat", label: "Chat", parent: "/" },
  { pattern: "/inbox", label: "Inbox", parent: "/" },
  { pattern: "/inbox/:id", label: "Message", parent: "/inbox" },
  { pattern: "/todos", label: "To-dos", parent: "/" },
  { pattern: "/todos/:id", label: "To-do", parent: "/todos" },
  { pattern: "/projects", label: "Projects", parent: "/" },
  { pattern: "/projects/new", label: "New project", parent: "/projects" },
  { pattern: "/projects/:slug", label: "Project", parent: "/projects" },
  { pattern: "/projects/:slug/cards/:id", label: "Card", parent: "/projects/:slug" },
  { pattern: "/projects/:slug/runs/:runNo", label: "Run", parent: "/projects/:slug" },
  { pattern: "/files", label: "Files", parent: "/" },
  { pattern: "/files/browse", label: "Browse", parent: "/" },
  { pattern: "/files/bridge", label: "Folder Bridge", parent: "/" },
  { pattern: "/bridge", label: "Folder Bridge", parent: "/files" },
  { pattern: "/fb/:token", label: "Folder Bridge", parent: "/files" },
  { pattern: "/system", label: "System", parent: "/" },
  { pattern: "/models", label: "Models", parent: "/system" },
  { pattern: "/tools", label: "Tools", parent: "/system" },
  { pattern: "/tools/:name", label: "Tool", parent: "/tools" },
  { pattern: "/profiles", label: "Profiles", parent: "/system" },
  { pattern: "/profiles/suggestions", label: "Suggestions", parent: "/profiles" },
  { pattern: "/skills", label: "Skills", parent: "/system" },
  { pattern: "/skills/:name", label: "Skill", parent: "/skills" },
  { pattern: "/skills/:name/edit", label: "Edit", parent: "/skills/:name" },
  { pattern: "/memory", label: "Memory", parent: "/system" },
  { pattern: "/graph", label: "Graph", parent: "/system" },
  { pattern: "/core", label: "Core", parent: "/system" },
  { pattern: "/webview", label: "Agent web browser", parent: "/system" },
  { pattern: "/settings", label: "Settings", parent: "/" },
  { pattern: "/settings/get-ready", label: "Get ready", parent: "/settings" },
  { pattern: "/settings/tools", label: "Tools & Integrations", parent: "/settings" },
  { pattern: "/settings/upgrade", label: "Software upgrade", parent: "/settings" },
  { pattern: "/settings/in-out", label: "In&Out", parent: "/settings" },
  { pattern: "/settings/in-out/google", label: "Google", parent: "/settings/in-out" },
  { pattern: "/settings/:section", label: "Settings", parent: "/settings" },
  { pattern: "/users", label: "People and roles", parent: "/settings" },
  { pattern: "/members", label: "Members", parent: "/settings" },
  { pattern: "/capacity", label: "Capacity", parent: "/settings" },
  { pattern: "/activity", label: "Activity", parent: "/" },
  { pattern: "/activity/:traceId", label: "Trace", parent: "/activity" },
  { pattern: "/onboarding", label: "Getting started", parent: "/" },
  { pattern: "/not-available", label: "Not available", parent: "/" },
  { pattern: "/default-profile-only", label: "Default profile only", parent: "/" },
];

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Match `pathname` against a pattern; returns captured params or null. */
function match(pattern: string, pathname: string): Record<string, string> | null {
  const p = split(pattern);
  const s = split(pathname);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = s[i];
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** Static segments win over `:param` ones (`/projects/new` before `/projects/:slug`). */
function find(pathname: string): { node: RouteNode; params: Record<string, string> } | null {
  let best: { node: RouteNode; params: Record<string, string>; score: number } | null = null;
  for (const node of ROUTES) {
    const params = match(node.pattern, pathname);
    if (!params) continue;
    const score = split(node.pattern).filter((x) => !x.startsWith(":")).length;
    if (!best || score > best.score) best = { node, params, score };
  }
  return best;
}

function fill(pattern: string, params: Record<string, string>): string {
  const out = split(pattern).map((seg) => (seg.startsWith(":") ? params[seg.slice(1)] ?? seg : seg));
  return `/${out.join("/")}`;
}

/** Nearest known ancestor for paths not in the table (drop trailing segments). */
function nearest(pathname: string) {
  const segs = split(pathname);
  for (let n = segs.length; n >= 0; n--) {
    const hit = find(`/${segs.slice(0, n).join("/")}`);
    if (hit) return { ...hit, exact: n === segs.length };
  }
  return null;
}

/**
 * The trail from Home to the current page (inclusive). `labels` overrides a
 * crumb's label by href, e.g. `{ "/projects/tender": "Tender bids" }`.
 */
export function routeTrail(pathname: string, labels: Record<string, string> = {}): Crumb[] {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const start = nearest(clean);
  if (!start) return [{ label: "Home", href: "/" }];
  const trail: Crumb[] = [];
  if (!start.exact) trail.push({ label: labels[clean] ?? start.node.label, href: clean });
  let node: RouteNode | undefined = start.node;
  const seen = new Set<string>();
  while (node && !seen.has(node.pattern)) {
    seen.add(node.pattern);
    const href = fill(node.pattern, start.params);
    trail.unshift({ label: labels[href] ?? node.label, href });
    node = node.parent ? ROUTES.find((r) => r.pattern === node!.parent) : undefined;
  }
  return trail;
}

/** The logical parent of the current page, or null on Home. */
export function logicalParent(pathname: string, labels?: Record<string, string>): Crumb | null {
  const trail = routeTrail(pathname, labels);
  return trail.length > 1 ? trail[trail.length - 2] : null;
}

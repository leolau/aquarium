/**
 * FG-33 decision 4: local apps live under a path on the main agent-home site,
 * not on their own origin.
 *
 *   prod  /apps/<slug>/…
 *   dev   /apps-dev/<slug>/…
 *
 * Dev is a sibling prefix rather than `/apps/<slug>/~dev` so the prod app's
 * own cookies (`Path=/apps/<slug>`) are never sent to the agent-editable dev
 * build. Each mode's Next.js is built with `basePath` set to its prefix.
 * `<slug>` is the registry name (`hermes_cli/tools_registry.py::_VALID_NAME`).
 */
export type AppMode = "prod" | "dev";

export const APP_PATH_PREFIXES: Readonly<Record<AppMode, string>> = {
  prod: "/apps",
  dev: "/apps-dev",
};

export const APP_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AppTarget {
  slug: string;
  mode: AppMode;
  /** `/apps/<slug>` or `/apps-dev/<slug>`, no trailing slash. */
  base: string;
}

export function appBasePath(slug: string, mode: AppMode): string {
  return `${APP_PATH_PREFIXES[mode]}/${slug}`;
}

function modeForPrefix(segment: string): AppMode | null {
  if (segment === "apps") return "prod";
  if (segment === "apps-dev") return "dev";
  return null;
}

/**
 * Parse the app a request URI (path + optional query, as Caddy sends it in
 * `X-Forwarded-Uri`) addresses. Anything ambiguous — dot segments, encoded
 * slashes/dots, backslashes — is refused rather than normalised, so the
 * slug checked here is the slug Caddy routed on.
 */
export function parseAppPath(uri: string): AppTarget | null {
  if (!uri.startsWith("/")) return null;
  const path = uri.split(/[?#]/, 1)[0];
  if (path.includes("\\") || /%(2f|5c|2e)/i.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  const mode = modeForPrefix(segments[1] ?? "");
  const slug = segments[2] ?? "";
  if (!mode || !APP_SLUG_RE.test(slug)) return null;
  return { slug, mode, base: appBasePath(slug, mode) };
}

/** True for any path under either app prefix (`/apps`, `/apps-dev`). */
export function isAppPath(pathname: string): boolean {
  return /^\/apps(-dev)?(\/|$)/.test(pathname);
}

export function isWithinApp(pathname: string, target: AppTarget): boolean {
  return pathname === target.base || pathname.startsWith(`${target.base}/`);
}

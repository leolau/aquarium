/**
 * Response headers Caddy sets on every `/apps/*` and `/apps-dev/*` response
 * (the per-instance block in `deploy/Caddyfile.agent-home` mirrors these; a
 * test keeps the two in step).
 *
 * The app shares agent-home's origin, so the CSP pins every fetch, script,
 * form and worker to the app's own path: an app page cannot call agent-home's
 * `/api/*` (connect-src), load its scripts, frame it, or register a service
 * worker over it. COOP `noopener-allow-popups` severs `window.opener` when an
 * app page opens (or is opened by) an agent-home page. Path-scoped CSP sources
 * are not checked after a redirect, which is why agent-home's middleware also
 * refuses requests whose Referer is an app page (`guard.ts`).
 */
import { appBasePath, type AppMode } from "@/lib/apps/paths";

export interface HeaderEntry {
  key: string;
  value: string;
}

/** Headers an app may not send: they act origin-wide, i.e. on agent-home. */
export const APP_STRIPPED_RESPONSE_HEADERS = ["Service-Worker-Allowed", "Clear-Site-Data"];

/** `origin` is e.g. `https://home.example.com` (Caddy: `https://{host}`). */
export function appContentSecurityPolicy(origin: string, slug: string, mode: AppMode): string {
  const base = `${origin}${appBasePath(slug, mode)}`;
  const self = `${base} ${base}/`;
  // No 'unsafe-eval' in either mode: the dev preview is a `next build` +
  // `node server.js` release like prod (aquarium-app-helper build), never
  // `next dev`, and a production Next.js/React bundle does not eval.
  const script = `${self} 'unsafe-inline'`;
  return [
    `default-src ${self}`,
    `script-src ${script}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `connect-src ${self}`,
    `worker-src ${self}`,
    `manifest-src ${self}`,
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${self}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

export function appResponseHeaders(origin: string, slug: string, mode: AppMode): HeaderEntry[] {
  return [
    { key: "Content-Security-Policy", value: appContentSecurityPolicy(origin, slug, mode) },
    { key: "Cross-Origin-Opener-Policy", value: "noopener-allow-popups" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
}

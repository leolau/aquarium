/**
 * Baseline security headers for every agent-home response, applied from
 * `next.config.mjs` `headers()`.
 *
 * The CSP is a baseline, not a script allowlist: Next.js streams its RSC
 * payload in inline `<script>` tags and `ThemeScript` runs inline before
 * paint, so `script-src` keeps `'unsafe-inline'` (a nonce CSP would need a
 * middleware and force every page dynamic). What it does lock down: no
 * plugins (`object-src`), no `<base>` hijack, forms post only here, the app
 * cannot be framed by another site, and fetch/WebSocket go only to this
 * origin (the app-mcp and Folder Bridge sockets dial `/app-mcp/*` on the same
 * host). If the browser ever talks to Supabase directly (realtime is off
 * today, see `lib/supabase/realtime.ts`), add that origin to `connect-src`.
 *
 * Chat and markdown may show images from any web URL, so `img-src` allows
 * http(s): an image cannot run script, and blocking them would break chats.
 *
 * The CSP is NOT applied under `/api/`: a `next.config` header overrides the
 * same header set by a route handler, and the file proxies there send their
 * own stricter sandbox CSP (`file-headers.ts`). The other headers are safe on
 * every response, so they go everywhere.
 */

/** `next.config` `headers()` source for pages: every path except `/api/*`. */
export const PAGE_HEADERS_SOURCE = "/:path((?!api/).*)";

/** @type {Record<string, string[]>} */
const PAGE_CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https:", "http:"],
  "media-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
};

/** @returns {string} */
export function pageContentSecurityPolicy() {
  return Object.entries(PAGE_CSP_DIRECTIVES)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** @returns {{ key: string, value: string }[]} */
export function pageSecurityHeaders() {
  return [{ key: "Content-Security-Policy", value: pageContentSecurityPolicy() }];
}

/** @returns {{ key: string, value: string }[]} */
export function baselineSecurityHeaders() {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    // FG-33 local apps share this origin under /apps/*: never share a
    // browsing context group (window.opener) with an app page.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
}

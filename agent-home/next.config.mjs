import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  baselineSecurityHeaders,
  PAGE_HEADERS_SOURCE,
  pageSecurityHeaders,
} from "./src/lib/http/security-headers.mjs";

/** Short git SHA of the checkout being built — what the deploy script
 *  reports as `deploy OK (<sha>)`. Baked into the bundle so the UI can show
 *  it and compare it against the server build (stale-bundle detection).
 *  HERMES_BUILD_SHA overrides it for CI/builds outside a git checkout. */
function resolveBuildSha() {
  if (process.env.HERMES_BUILD_SHA) return process.env.HERMES_BUILD_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

/** When this bundle was built (ISO-8601) — shown next to the build SHA so a
 *  stale tab or a slow deploy is obvious. HERMES_BUILD_TIME overrides it. */
function resolveBuildTime() {
  return process.env.HERMES_BUILD_TIME || new Date().toISOString();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_HERMES_BUILD: resolveBuildSha(),
    NEXT_PUBLIC_HERMES_BUILD_TIME: resolveBuildTime(),
  },
  // Unlike `web/` (a static SPA export served by the Python backend),
  // `agent-home` runs as a real Next.js **server** (App Router + route
  // handlers) behind Caddy on the prod box. It is the BFF (FG-20 Decision 1):
  // it holds the C1 principal session, proxies agent/authority calls to the
  // Python `/api/*` layer, and does server-side Supabase reads with the
  // principal's RLS context. So there is deliberately NO `output: "export"`.
  reactStrictMode: true,
  // Release tarballs (scripts/build-release.sh) ship a self-contained server
  // so customer boxes never run `next build`. Tracing starts at the repo root
  // because npm workspaces hoist node_modules there.
  ...(process.env.AQUARIUM_STANDALONE === "1"
    ? {
        output: "standalone",
        outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
        // UI strings are read from disk at runtime (src/i18n/load.ts).
        outputFileTracingIncludes: { "/**": ["./src/i18n/messages/**/*.json"] },
      }
    : {}),
  // Lint and typecheck run as dedicated `npm run lint` / `npm run typecheck`
  // steps (and in CI); don't couple them to the production build.
  eslint: { ignoreDuringBuilds: true },
  // `pg` is a server-only dependency; never bundle it into client chunks.
  serverExternalPackages: ["pg"],
  // An activation URL *is* the credential until it is redeemed, so the browser
  // must not hand it to the next site in a `Referer` header (a single click on
  // an outbound link would otherwise disclose a live token), and crawlers must
  // not index it. `robots` is also set as page metadata; the header covers the
  // fetch of the page itself.
  async headers() {
    return [
      // Baseline for every response; listed first so the entries below (the
      // later entry wins per key) can tighten Referrer-Policy. The page CSP
      // skips /api/ so the file proxies keep their own sandbox CSP
      // (src/lib/http/file-headers.ts).
      { source: "/:path*", headers: baselineSecurityHeaders() },
      { source: PAGE_HEADERS_SOURCE, headers: pageSecurityHeaders() },
      {
        source: "/activate/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
      {
        // First-run owner setup: the one-time token sits in the URL fragment.
        source: "/setup",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
      {
        // A survey link identifies one attendee; same treatment as activation.
        source: "/survey/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;

/**
 * The shared `test`: every page is watched for browser console errors,
 * uncaught exceptions and failed BFF (`/api/*`) requests, and a test that
 * passed its own assertions still fails if any were seen. Known, explained
 * noise goes in KNOWN_NOISE below — or `guard.allow()` for a single test.
 */
import { test as base, expect, type Page } from "@playwright/test";

import { credentials, storageStatePath, type Role } from "./env";

interface KnownNoise {
  /** Matched against `"<METHOD> <path> <status>"` or the console text. */
  pattern: RegExp;
  why: string;
}

const KNOWN_NOISE: KnownNoise[] = [
  {
    pattern: /^GET \/api\/email-accounts 403$/,
    why: "Settings → Email mailboxes probes an owner-only route for every role and renders its own 'not allowed' state.",
  },
];

/**
 * `E2E_IGNORE` — extra patterns (one regex per line) to tolerate for one run,
 * e.g. a known issue already fixed on develop but not yet deployed.
 */
const IGNORED: RegExp[] = (process.env.E2E_IGNORE ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => new RegExp(line));

export interface Guard {
  /** Tolerate matching failures for the rest of this test. */
  allow(pattern: RegExp): void;
  /** What has been seen so far (for specs that assert mid-test). */
  problems(): string[];
}

function watch(page: Page, origin: string, allowed: RegExp[]): () => string[] {
  const seen: string[] = [];
  const isAllowed = (line: string) =>
    allowed.some((re) => re.test(line)) ||
    IGNORED.some((re) => re.test(line)) ||
    KNOWN_NOISE.some((n) => n.pattern.test(line));
  const push = (line: string) => {
    if (!isAllowed(line)) seen.push(line);
  };
  const ownPath = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      return url.origin === origin ? url.pathname : null;
    } catch {
      return null;
    }
  };

  page.on("response", (res) => {
    const path = ownPath(res.url());
    if (!path || res.status() < 400) return;
    // A 4xx/5xx from the BFF, or any 5xx/404 for the app's own assets.
    if (path.startsWith("/api/") || res.status() >= 500 || path.startsWith("/_next/")) {
      push(`${res.request().method()} ${path} ${res.status()}`);
    }
  });
  page.on("requestfailed", (req) => {
    const path = ownPath(req.url());
    const reason = req.failure()?.errorText ?? "";
    // Navigation / unmount aborts (streams, prefetches) are not failures.
    if (!path?.startsWith("/api/") || /ERR_ABORTED|NS_BINDING_ABORTED|cancel/i.test(reason)) return;
    push(`${req.method()} ${path} failed: ${reason}`);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // The response listener already reports our own failed loads with
    // method + path; the console copy has neither.
    if (/^Failed to load resource/.test(text) && ownPath(msg.location().url ?? "")) return;
    push(`console: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (err) => push(`pageerror: ${err.message.slice(0, 300)}`));
  return () => seen;
}

export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, baseURL }, provide, testInfo) => {
      const allowed: RegExp[] = [];
      const problems = watch(page, new URL(baseURL ?? "http://localhost").origin, allowed);
      await provide({ allow: (re) => allowed.push(re), problems });
      if (testInfo.status === testInfo.expectedStatus && problems().length > 0) {
        await testInfo.attach("browser-problems", { body: problems().join("\n") });
        expect(problems(), "console errors / failed BFF requests").toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Run the enclosing `describe` signed in as `role`, or skip it when that
 * role's SMOKE_* credentials are not set.
 */
export function asRole(role: Role): void {
  // Credentials decide at collection time; a failed sign-in fails the
  // `setup` project, which skips every dependent spec on its own.
  const ready = credentials(role) !== null;
  test.skip(!ready, `SMOKE_${role.toUpperCase()}_EMAIL/PASSWORD not set — skipping ${role} specs`);
  if (ready) test.use({ storageState: storageStatePath(role) });
}

/** Specs that create data run once (desktop), not once per viewport. */
export function desktopOnly(): void {
  test.skip(({ isMobile }) => isMobile, "data-creating spec runs on desktop only");
}

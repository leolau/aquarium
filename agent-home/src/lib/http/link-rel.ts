/**
 * `rel` for a link that opens in a new tab.
 *
 * Same-origin links must keep their Referer: agent-home's middleware refuses
 * same-origin `/api/` requests that arrive without one (lib/apps/guard.ts),
 * so `noreferrer` on a file route makes "Open" fail with `missing_referer`.
 * Links to other sites keep `noreferrer` so our URLs don't leak to them.
 */
export function newTabRel(href: string | null | undefined): string {
  if (!href) return "noopener noreferrer";
  if (href.startsWith("/") && !href.startsWith("//")) return "noopener";
  if (typeof window !== "undefined") {
    try {
      if (new URL(href, window.location.href).origin === window.location.origin) {
        return "noopener";
      }
    } catch {
      // not a URL: treat as external
    }
  }
  return "noopener noreferrer";
}

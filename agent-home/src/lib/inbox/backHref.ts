/**
 * Where `/inbox/:id`'s Back goes. `from=landing` (a row in the landing
 * Incomings tab) returns Home; an Inbox query string returns to that filtered
 * list; anything else is the plain Inbox (no open redirects).
 */
export function inboxBackHref(from: string | string[] | undefined): string {
  const value = Array.isArray(from) ? from[0] : from;
  if (value === "landing") return "/";
  return value && value.startsWith("?") && !value.includes("//") ? `/inbox${value}` : "/inbox";
}

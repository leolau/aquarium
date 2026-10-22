/**
 * Server-safe time rendering for the project pages. Epoch seconds in, human
 * distances out — the Python layer stores integers, and the panels never
 * need more than the minute grain.
 */

/** "today" | "in 3d" | "5d ago" — the list/card grain. */
export function dayDistance(epochSeconds: number): string {
  const days = Math.round((epochSeconds * 1000 - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}

/** "3h 12m" | "45s" — durations on run rows. */
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** "950", "957.5K", "1.45M" — a token count at a glance. */
export function tokenCountLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** "12 Aug, 14:05" — when the day matters more than the distance. */
export function dateTimeLabel(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "21d ago" — last-review and history lines. */
export function agoLabel(epochSeconds: number | null): string {
  if (epochSeconds == null) return "never";
  const seconds = Date.now() / 1000 - epochSeconds;
  if (seconds < 0) return "just now";
  const days = Math.floor(seconds / 86_400);
  if (days === 0) {
    const hours = Math.floor(seconds / 3600);
    return hours === 0 ? "just now" : `${hours}h ago`;
  }
  return `${days}d ago`;
}

/** One model call's response time: "820ms", "4.1s", "5m 16s". */
export function callDurationLabel(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

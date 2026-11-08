/**
 * "3 days ago", "yesterday", "2 hours ago" in the person's language, from an
 * ISO time. Null for a missing or unreadable time, so callers can leave it out.
 */
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

export function timeAgo(iso: string | null | undefined, locale: string, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  let amount = Math.max(0, (now - then) / 1000);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (amount < 45) return fmt.format(0, "second");
  for (const [unit, size] of STEPS) {
    if (amount < size) return fmt.format(-Math.floor(amount), unit);
    amount /= size;
  }
  return null;
}

/** First letter up, for a time that starts a line ("Yesterday · …"). */
export function capitalized(text: string): string {
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

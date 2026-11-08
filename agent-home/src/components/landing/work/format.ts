/** "just now", "8 min", "1 h", "3 d" — how long an item has been waiting. */
export function fmtAge(createdAtSec: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - createdAtSec));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

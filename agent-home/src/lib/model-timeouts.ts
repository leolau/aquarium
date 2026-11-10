/** Model API timeouts per provider and per model (`providers.*` in config.yaml). */

export interface ModelTimeout {
  provider: string;
  /** null = every model of the provider (`request_timeout_seconds`). */
  model: string | null;
  timeout_seconds: number;
}

export interface ModelInUse {
  provider: string;
  model: string;
  /** What calls it: "chat", "fallback", or an auxiliary task such as "vision". */
  used_by: string[];
}

export interface ModelTimeoutsState {
  timeouts: ModelTimeout[];
  in_use: ModelInUse[];
  min_seconds: number;
  max_seconds: number;
}

export interface ModelTimeoutChange {
  provider: string;
  model: string | null;
  /** null clears it, so the built-in default applies again. */
  timeout_seconds: number | null;
}

export const TIMEOUT_MIN_SECONDS = 5;
export const TIMEOUT_MAX_SECONDS = 3600;

export interface ModelTimeoutRow {
  provider: string;
  model: string | null;
  timeout_seconds: number | null;
  used_by: string[];
}

/**
 * One row per provider (all models) and per provider/model pair that is in
 * use or has a timeout; providers in name order, the provider-wide row first.
 */
export function timeoutRows(state: ModelTimeoutsState): ModelTimeoutRow[] {
  const rows = new Map<string, ModelTimeoutRow>();
  const key = (p: string, m: string | null) => `${p}\u0000${m ?? ""}`;
  const ensure = (provider: string, model: string | null) => {
    const k = key(provider, model);
    let row = rows.get(k);
    if (!row) {
      row = { provider, model, timeout_seconds: null, used_by: [] };
      rows.set(k, row);
    }
    return row;
  };
  for (const use of state.in_use) {
    ensure(use.provider, null);
    ensure(use.provider, use.model).used_by.push(...use.used_by);
  }
  for (const t of state.timeouts) {
    if (t.model !== null) ensure(t.provider, null);
    ensure(t.provider, t.model).timeout_seconds = t.timeout_seconds;
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      (a.model === null ? -1 : b.model === null ? 1 : a.model.localeCompare(b.model)),
  );
}

/** `"240"` → 240; empty → null (clear); anything out of range → undefined. */
export function parseTimeoutInput(
  raw: string,
  min = TIMEOUT_MIN_SECONDS,
  max = TIMEOUT_MAX_SECONDS,
): number | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
}

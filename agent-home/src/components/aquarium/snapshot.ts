/**
 * Reading `GET /api/aquarium` and polling it. The poller chains timeouts (no
 * overlapping requests), skips ticks while the tab is hidden and fetches
 * again as soon as it is visible.
 */
import {
  SNAPSHOT_POLL_MS,
  isCreatureId,
  type AquariumProfile,
  type AquariumSnapshot,
  type AquariumUser,
} from "@/lib/aquarium/creatures";

import { profileCreature } from "./mapping";

export const SNAPSHOT_URL = "/api/aquarium";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseProfile(raw: unknown): AquariumProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const name = str(p.name);
  if (!name) return null;
  return { name, display_name: str(p.display_name) ?? name };
}

function parseUser(raw: unknown): AquariumUser | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const userId = str(u.user_id);
  if (!userId) return null;
  const m = (u.metrics && typeof u.metrics === "object" ? u.metrics : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const profiles: AquariumProfile[] = [];
  for (const p of Array.isArray(u.profiles) ? u.profiles : []) {
    const parsed = parseProfile(p);
    if (parsed && !seen.has(parsed.name)) {
      seen.add(parsed.name);
      profiles.push(parsed);
    }
  }
  return {
    user_id: userId,
    name: str(u.name) ?? userId,
    creature: isCreatureId(u.creature) ? u.creature : profileCreature(userId),
    is_self: u.is_self === true,
    metrics: {
      chats: num(m.chats),
      projects: num(m.projects),
      tokens_in: num(m.tokens_in),
      tokens_out: num(m.tokens_out),
      tokens_24h: num(m.tokens_24h),
      active_now: m.active_now === true,
    },
    profiles,
  };
}

/** Validates a snapshot body; drops malformed people rather than failing the frame. */
export function parseSnapshot(raw: unknown): AquariumSnapshot {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { users?: unknown }).users)) {
    throw new Error("Malformed aquarium snapshot");
  }
  const body = raw as { generated_at?: unknown; idle_seconds?: unknown; users: unknown[] };
  const seen = new Set<string>();
  const users: AquariumUser[] = [];
  for (const u of body.users) {
    const parsed = parseUser(u);
    if (parsed && !seen.has(parsed.user_id)) {
      seen.add(parsed.user_id);
      users.push(parsed);
    }
  }
  return { generated_at: num(body.generated_at), idle_seconds: num(body.idle_seconds), users };
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<AquariumSnapshot> {
  const res = await fetch(SNAPSHOT_URL, { cache: "no-store", signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseSnapshot(await res.json());
}

export interface VisibilitySource {
  isHidden(): boolean;
  subscribe(onChange: () => void): () => void;
}

export const documentVisibility: VisibilitySource = {
  isHidden: () => typeof document !== "undefined" && document.hidden,
  subscribe(onChange) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
};

export interface SnapshotPollerOptions {
  load?: (signal: AbortSignal) => Promise<AquariumSnapshot>;
  onSnapshot: (snapshot: AquariumSnapshot) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
  visibility?: VisibilitySource;
}

/** Starts polling right away; returns a stop function. */
export function startSnapshotPolling({
  load = fetchSnapshot,
  onSnapshot,
  onError,
  intervalMs = SNAPSHOT_POLL_MS,
  visibility = documentVisibility,
}: SnapshotPollerOptions): () => void {
  let stopped = false;
  let waitingForVisible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    if (visibility.isHidden()) {
      waitingForVisible = true;
      return;
    }
    const current = new AbortController();
    controller = current;
    try {
      const snapshot = await load(current.signal);
      if (!stopped) onSnapshot(snapshot);
    } catch (err) {
      if (!stopped) onError(err);
    }
    controller = undefined;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  const unsubscribe = visibility.subscribe(() => {
    if (stopped || !waitingForVisible || visibility.isHidden()) return;
    waitingForVisible = false;
    void tick();
  });
  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
    unsubscribe();
  };
}

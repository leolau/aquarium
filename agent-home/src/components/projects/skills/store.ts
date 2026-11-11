"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { getJson } from "@/lib/admin-fetch";
import type { ProjectSkillsResponse } from "@/types";

import { normalizeProjectSkills, type ProjectSkillsView, type SkillWindow } from "./model";

export type ProjectSkillsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; view: ProjectSkillsView };

const LOADING: ProjectSkillsState = { status: "loading" };
const cache = new Map<string, ProjectSkillsState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const keyOf = (slug: string, days: number) => `${slug}|${days}`;
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function projectSkillsUrl(slug: string, days: number): string {
  return `/api/projects/${encodeURIComponent(slug)}/skills?days=${days}`;
}

function load(slug: string, days: number, force = false): Promise<void> {
  const key = keyOf(slug, days);
  if (!force && (cache.has(key) || inflight.has(key))) return inflight.get(key) ?? Promise.resolve();
  if (force) {
    cache.delete(key);
    emit();
  }
  const job = getJson<ProjectSkillsResponse>(projectSkillsUrl(slug, days))
    .then((raw) => {
      cache.set(key, { status: "ready", view: normalizeProjectSkills(raw, days) });
    })
    .catch((err: unknown) => {
      cache.set(key, { status: "error", error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      inflight.delete(key);
      emit();
    });
  inflight.set(key, job);
  return job;
}

/** Test hook: forget every cached response. */
export function resetProjectSkillsCache(): void {
  cache.clear();
  inflight.clear();
  emit();
}

/** Drop a dismissed candidate from every cached window (they are window-independent). */
export function dropCandidate(slug: string, id: string): void {
  for (const [k, value] of cache) {
    if (!k.startsWith(`${slug}|`) || value.status !== "ready") continue;
    cache.set(k, {
      status: "ready",
      view: { ...value.view, candidates: value.view.candidates.filter((c) => c.id !== id) },
    });
  }
  emit();
}

/** One shared read per project + window, so the tab badge and the tab agree. */
export function useProjectSkills(slug: string, days: SkillWindow) {
  const key = keyOf(slug, days);
  const state = useSyncExternalStore(
    subscribe,
    () => cache.get(key) ?? LOADING,
    () => LOADING,
  );
  useEffect(() => {
    void load(slug, days);
  }, [slug, days]);
  const reload = useCallback(() => load(slug, days, true), [slug, days]);
  return { state, reload };
}

/** Badge on the Skills tab: undismissed retro candidates (0 while loading or on error). */
export function useProjectSkillCandidateCount(slug: string): number {
  const { state } = useProjectSkills(slug, 90);
  return state.status === "ready" ? state.view.candidates.length : 0;
}

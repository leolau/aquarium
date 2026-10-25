"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { friendlyError } from "@/components/projects/errors";
import type { ProjectCategoriesResponse, ProjectCategory } from "@/types";

export const PROJECT_CATEGORIES_PATH = "/api/project-categories";

/** Column order: `position`, then `created_at` — the API's own order. */
export function sortCategories(list: readonly ProjectCategory[]): ProjectCategory[] {
  return [...list].sort((a, b) => a.position - b.position || a.created_at - b.created_at);
}

/** One uncached read of the instance's categories, in column order. */
export async function fetchProjectCategories(
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectCategory[]> {
  let res: Response;
  try {
    res = await fetchImpl(PROJECT_CATEGORIES_PATH, { cache: "no-store" });
  } catch {
    throw new Error("Could not reach the server.");
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<ProjectCategoriesResponse> & { detail?: unknown })
    | null;
  if (!res.ok) {
    throw new Error(
      friendlyError({ status: res.status, detail: data?.detail }, "Could not load the categories."),
    );
  }
  return sortCategories(Array.isArray(data?.items) ? data.items : []);
}

export interface ProjectCategoriesState {
  categories: ProjectCategory[];
  loading: boolean;
  error: string | null;
  /** Re-read the list; resolves the fresh list, or null when the read failed. */
  reload: () => Promise<ProjectCategory[] | null>;
}

/**
 * The instance's project categories (GET `/api/project-categories`, never
 * cached). Reads once on mount unless `initial` is given — then that list
 * shows until `reload()` is called. A stale answer never overwrites a newer one.
 */
export function useProjectCategories({
  initial,
  fetchImpl,
}: { initial?: readonly ProjectCategory[]; fetchImpl?: typeof fetch } = {}): ProjectCategoriesState {
  const [categories, setCategories] = useState<ProjectCategory[]>(() =>
    sortCategories(initial ?? []),
  );
  const [loading, setLoading] = useState(initial === undefined);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const readOnMount = useRef(initial === undefined);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const fresh = await fetchProjectCategories(fetchImpl ?? fetch);
      if (mine === seq.current) setCategories(fresh);
      return fresh;
    } catch (e) {
      if (mine === seq.current) {
        setError(e instanceof Error ? e.message : "Could not load the categories.");
      }
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetchImpl]);

  useEffect(() => {
    const counter = seq;
    if (readOnMount.current) void reload();
    return () => {
      // Unmounted: drop whatever is still in flight.
      counter.current++;
    };
  }, [reload]);

  return { categories, loading, error, reload };
}

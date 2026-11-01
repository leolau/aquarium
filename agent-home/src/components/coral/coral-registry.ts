/**
 * Coral registry — where apps register and the launcher gets its layout.
 *
 * Pure and SSR-safe: registration happens at module import (coral-apps.ts),
 * the same on server and client, and nothing here touches the DOM or cookies.
 * All validation failures throw at build time (the registry is exercised by
 * unit tests and by `next build`), never at user runtime.
 */
import type { AppKind, AppManifest } from "@/components/coral/coral-types";
import { LOCKED_APP_IDS } from "@/lib/nav/menu-access";
import {
  CLUSTER_CATEGORIES,
  MAX_CLUSTER_MEMBERS,
  MAX_PETALS,
} from "@/components/coral/coral-types";

interface ClusterDef {
  label: string;
  glyph: string;
}

const apps: AppManifest[] = [];
const clusters = new Map<string, ClusterDef>();

const KINDS: readonly AppKind[] = ["next-route", "webview", "composed"];

/**
 * Register an app. Duplicate ids or routes throw — a silent second
 * registration of the same destination would render two petals pointing at
 * one route, which is the drift this registry exists to prevent.
 */
export function registerApp(manifest: AppManifest): void {
  if (!manifest.id) throw new Error("coral: app manifest needs an id");
  if (!manifest.route.startsWith("/")) {
    throw new Error(
      `coral: app "${manifest.id}" route must start with "/" (got "${manifest.route}")`,
    );
  }
  if (!KINDS.includes(manifest.kind)) {
    throw new Error(`coral: app "${manifest.id}" has unknown kind "${manifest.kind}"`);
  }
  if (apps.some((a) => a.id === manifest.id)) {
    throw new Error(`coral: duplicate app id "${manifest.id}"`);
  }
  if (apps.some((a) => a.route === manifest.route)) {
    throw new Error(
      `coral: app "${manifest.id}" reuses route "${manifest.route}" — one app per route`,
    );
  }
  apps.push(manifest);
}

/** Register a cluster (folder petal) that groups apps by category id. */
export function registerCluster(id: string, def: ClusterDef): void {
  if (clusters.has(id)) throw new Error(`coral: duplicate cluster id "${id}"`);
  clusters.set(id, def);
}

/** All registered apps, in category-then-order sequence. */
export function getApps(): AppManifest[] {
  return [...apps].sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.order - b.order || a.id.localeCompare(b.id),
  );
}

export type CoralPetal =
  | { type: "app"; app: AppManifest }
  | { type: "cluster"; id: string; label: string; glyph: string; members: AppManifest[] };

/**
 * Build the launcher layout: categories in `CLUSTER_CATEGORIES` become one
 * cluster petal holding their members; every other app is its own petal.
 *
 * Enforces the two hard caps from the design doc — a 9th top-level petal or a
 * 9th cluster member throws with a message that tells the author what to do,
 * so grouping decisions are made deliberately, never by silent clipping.
 * Top-level order: an app petal sorts by its own `order`; a cluster sorts by
 * the minimum `order` of its members.
 *
 * `hidden` (Settings → Menu, per role) drops those apps first; a cluster left
 * with no members disappears. Locked apps (home, settings) are never dropped.
 */
export function buildCoralLayout(
  options: { hidden?: readonly string[] } = {},
): CoralPetal[] {
  const hidden = new Set(
    (options.hidden ?? []).filter((id) => !LOCKED_APP_IDS.includes(id)),
  );
  const byCategory = new Map<string, AppManifest[]>();
  for (const app of apps) {
    if (hidden.has(app.id)) continue;
    const bucket = byCategory.get(app.category) ?? [];
    bucket.push(app);
    byCategory.set(app.category, bucket);
  }

  const petals: CoralPetal[] = [];
  for (const [category, members] of byCategory) {
    const sorted = members.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    if (CLUSTER_CATEGORIES.includes(category)) {
      const def = clusters.get(category);
      if (!def) {
        throw new Error(
          `coral: cluster category "${category}" has apps but no registerCluster() definition`,
        );
      }
      if (sorted.length > MAX_CLUSTER_MEMBERS) {
        throw new Error(
          `coral: cluster "${category}" has ${sorted.length} members — the cap is ${MAX_CLUSTER_MEMBERS}; regroup apps into a different category`,
        );
      }
      petals.push({ type: "cluster", id: category, ...def, members: sorted });
    } else {
      if (sorted.length > 1) {
        throw new Error(
          `coral: category "${category}" holds ${sorted.length} apps but is not a cluster — add it to CLUSTER_CATEGORIES or give each app its own category`,
        );
      }
      petals.push({ type: "app", app: sorted[0] });
    }
  }

  petals.sort((a, b) => petalOrder(a) - petalOrder(b));
  if (petals.length > MAX_PETALS) {
    throw new Error(
      `coral: ${petals.length} top-level petals exceed the cap of ${MAX_PETALS} — move a destination into a cluster`,
    );
  }
  return petals;
}

function petalOrder(petal: CoralPetal): number {
  if (petal.type === "app") return petal.app.order;
  return Math.min(...petal.members.map((m) => m.order));
}

/** Whether `pathname` should mark `route` active (root only matches exactly). */
export function isAppActive(pathname: string, route: string): boolean {
  return route === "/" ? pathname === "/" : pathname.startsWith(route);
}

/** Test hook — clears the registries. Never call from app code. */
export function __resetCoralRegistryForTests(): void {
  apps.length = 0;
  clusters.clear();
}

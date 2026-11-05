/**
 * Coral — the app registry contract (design: docs/design/coral-app-framework.md).
 *
 * A destination in agent-home is an *app*: a manifest entry, not a hardcoded
 * menu row. Phase 1 registers all apps in code; Phase 2 hydrates user-created
 * apps from Supabase through the BFF and the launcher consumes the same shape,
 * so this interface is deliberately the Phase-2 `AppManifest`, not a Phase-1
 * simplification of it.
 */

/** App kinds. Phase 1 registers `next-route` only; the others are reserved. */
export type AppKind = "next-route" | "webview" | "composed";

/**
 * A named badge slot, not a number — the count arrives from the shell as a
 * prop so the registry stays a plain, server-safe constant (same contract the
 * old `NavItem.badge` had). `chat-unread` is fed client-side by the
 * launcher's unread hook (last-read state lives in the browser).
 */
export type BadgeSlot = "todos-open" | "chat-unread";

export interface AppManifest {
  /** Stable unique id, kebab-case: "todos", "memory-map". */
  id: string;
  /** Human label shown on the petal. */
  name: string;
  /** Glyph id rendered by the glyph system. */
  glyph: string;
  /** Short one-line description (was `NavItem.hint`). */
  hint?: string;
  /**
   * Where the app lives. Phase 1 only registers `next-route`; `webview`
   * (the existing /webview CDP surface) and `composed` (Phase 2 user-built
   * schema-driven pages) are reserved so the launcher never branches on
   * registration source.
   */
  kind: AppKind;
  /** Internal path for `next-route` apps, e.g. "/todos". */
  route: string;
  /**
   * Cluster id. Categories whose id is in `CLUSTER_CATEGORIES` render as a
   * cluster petal with a fan-out of members; any other category id becomes a
   * top-level app petal.
   */
  category: string;
  /** Position within its category. */
  order: number;
  /** Named badge slot filled server-side, as today. */
  badgeSlot?: BadgeSlot;
}

/**
 * Category ids that render as cluster petals (a folder that fans out its
 * members). Everything else is a direct app petal. Top-level ordering among
 * petals is the minimum `order` of the category's members, so clusters sit
 * where their first member sits.
 */
export const CLUSTER_CATEGORIES: readonly string[] = ["workspace", "system"];

/** Hard cap on top-level petals (apps + clusters). Design doc §4.3. */
export const MAX_PETALS = 8;

/**
 * Hard cap on members of a single cluster. Design doc §4.3 set 8; raised to
 * 10 when Profiles and Skills joined System (the grid panel shows every
 * section flat, so a 10-tile section still fits without nesting).
 */
export const MAX_CLUSTER_MEMBERS = 10;

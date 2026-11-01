import { fileURLToPath } from "node:url";

export type Role = "admin" | "member" | "viewer";
export const ROLES: readonly Role[] = ["admin", "member", "viewer"];

export interface Credentials {
  email: string;
  password: string;
}

/** Test-account credentials from `SMOKE_<ROLE>_EMAIL/PASSWORD`, or null. */
export function credentials(role: Role): Credentials | null {
  const key = role.toUpperCase();
  const email = process.env[`SMOKE_${key}_EMAIL`]?.trim();
  const password = process.env[`SMOKE_${key}_PASSWORD`];
  return email && password ? { email, password } : null;
}

/** Login provider the test accounts use (the box offers basic + supabase). */
export const LOGIN_PROVIDER = process.env.E2E_LOGIN_PROVIDER || "supabase";

/** Where `auth.setup.ts` leaves each role's signed-in browser state. */
export function storageStatePath(role: Role): string {
  return fileURLToPath(new URL(`../.auth/${role}.json`, import.meta.url));
}

/** Every piece of data a spec creates carries this prefix (cleanup key). */
export const SMOKE_PREFIX = "[smoke]";

/** `[smoke] <label> <timestamp>` — unique per run, recognisable by sweeps. */
export function smokeName(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${SMOKE_PREFIX} ${label} ${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

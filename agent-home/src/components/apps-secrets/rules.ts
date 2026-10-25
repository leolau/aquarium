/**
 * The rules an app secret must meet before it is sent anywhere, mirroring the
 * root helper's `set-secret` checks (`deploy/aquarium-app-helper`
 * `check_secret_name`, `MAX_SECRET_BYTES`). The helper stays the authority;
 * these only refuse early so a bad request never leaves the browser or BFF.
 * Pure (no DOM, no server imports): the form and the BFF route share it.
 */

export type AppMode = "dev" | "prod";

/** Same slug rule as the helper and `aquarium apps db` (APP_SLUG_RE). */
export const APP_SLUG_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RESERVED_SECRET_PREFIXES = [
  "DATABASE_URL",
  "NEXT_PUBLIC_",
  "NODE_",
  "APP_",
  "CREDENTIALS_",
] as const;
export const RESERVED_SECRET_NAMES = new Set([
  "PORT",
  "HOSTNAME",
  "HOME",
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);
/** Minted by the runtime (`hermes_cli/app_runtime.py`); shown, never set by hand. */
export const MANAGED_SECRET_NAMES = new Set(["APP_MCP_TOKEN"]);
export const MAX_SECRET_BYTES = 8192;

export type SecretNameProblem = "format" | "reserved" | "managed";
export type SecretValueProblem = "empty" | "too_large" | "nul";

export function isAppSlug(slug: string): boolean {
  return APP_SLUG_RE.test(slug) && !slug.includes("--");
}

export function isAppMode(mode: unknown): mode is AppMode {
  return mode === "dev" || mode === "prod";
}

export function secretNameProblem(name: string): SecretNameProblem | null {
  if (!SECRET_NAME_RE.test(name)) return "format";
  if (MANAGED_SECRET_NAMES.has(name)) return "managed";
  if (RESERVED_SECRET_NAMES.has(name)) return "reserved";
  if (RESERVED_SECRET_PREFIXES.some((p) => name.startsWith(p))) return "reserved";
  return null;
}

export function secretValueProblem(value: string): SecretValueProblem | null {
  if (!value) return "empty";
  if (value.includes("\u0000")) return "nul";
  if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) return "too_large";
  return null;
}

/** What the helper answers, minus anything else upstream might add. */
export interface AppSecretsResult {
  mode: AppMode;
  secret_names: string[];
  restart_needed: boolean;
}

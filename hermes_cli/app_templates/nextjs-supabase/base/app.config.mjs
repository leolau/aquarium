// Values fixed when this app was scaffolded. tool.config.json is the manifest
// Aquarium reads; this file is what the app's own code imports.
export const APP_NAME = "{{name}}";
export const APP_SLUG = "{{slug}}";
/** "local" (this Aquarium box) or "external" (a hosting provider). */
export const HOSTING = "{{hosting}}";
/** Provider id for external apps, null for local apps. */
export const PROVIDER = orNull("{{provider}}");
/** End-user identity: "aquarium" (front-door header), "supabase" or "none". */
export const AUTH_MODE = "{{auth}}";
export const TEMPLATE_VERSION = "{{template_version}}";

function orNull(value) {
  return value || null;
}

/** @returns {"dev" | "prod"} */
export function appMode(env = process.env) {
  return env.APP_MODE === "prod" ? "prod" : "dev";
}

/**
 * URL prefix the app is served under. Local apps live under a path on the
 * main site: /apps/<slug> (prod) and /apps-dev/<slug> (dev). External apps
 * own their origin, so the prefix is empty. APP_BASE_PATH (set by the
 * runtime) wins when present.
 */
export function basePath(env = process.env) {
  if (typeof env.APP_BASE_PATH === "string") return env.APP_BASE_PATH;
  if (HOSTING !== "local") return "";
  return appMode(env) === "prod" ? `/apps/${APP_SLUG}` : `/apps-dev/${APP_SLUG}`;
}

/** Whether `next build` should emit the self-contained `node server.js` output. */
export function standaloneOutput() {
  return HOSTING === "local" || !["vercel", "aws_amplify"].includes(PROVIDER ?? "");
}

/**
 * Shared plumbing for the FG-33 app BFF routes under `/api/tools/apps/[name]`.
 *
 * Every route proxies to the Python `/api/tools/{name}/…` authority as the
 * signed-in caller. Who may act on which app (the app's owner, an admin or
 * the instance owner; decision 9) is decided upstream per app, so these
 * routes only validate the request shape.
 */
import { NextResponse } from "next/server";

import { readBody } from "@/app/api/projects/hermes-bridge";

export interface AppCtx {
  params: Promise<{ name: string }>;
}

export type AppMode = "dev" | "prod";

/** Registry names and app slugs: no slashes, dots or spaces reach upstream. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export interface AppCall {
  name: string;
  mode: AppMode | undefined;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

function bad(error: string, detail: string): NextResponse {
  return NextResponse.json({ error, detail }, { status: 400 });
}

/** The upstream path for one app, with only the defined query values. */
export function toolPath(
  name: string,
  suffix = "",
  query: Record<string, string | number | undefined> = {},
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const tail = qs.size ? `?${qs.toString()}` : "";
  return `/api/tools/${encodeURIComponent(name)}${suffix}${tail}`;
}

/**
 * Parse `[name]`, the optional `mode` (body first, then `?mode=`) and the
 * JSON body. A malformed name or mode is a 400 before anything is proxied.
 */
export async function appCall(request: Request, ctx: AppCtx): Promise<AppCall | NextResponse> {
  const { name } = await ctx.params;
  if (!NAME_RE.test(name)) return bad("bad_name", "That is not an app name.");
  const query = new URL(request.url).searchParams;
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "DELETE" ? {} : await readBody(request);
  const rawMode = body.mode ?? query.get("mode") ?? undefined;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "dev" && rawMode !== "prod") {
    return bad("bad_mode", "mode must be dev or prod");
  }
  const mode = (rawMode ?? undefined) as AppMode | undefined;
  return { name, mode, body, query };
}

/** Decision 9's one explicit confirmation: the typed app name must match. */
export function confirmMatches(call: AppCall, confirm: unknown): NextResponse | null {
  if (confirm !== call.name) {
    return bad("confirm_required", "Type the app's name to confirm. This cannot be undone.");
  }
  return null;
}

export { bad as badRequest };

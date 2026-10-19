/**
 * GET /api/browse/file?place=&path=[&download=1] — a file's bytes, streamed
 * through the BFF. The bytes come from a share or a workspace nobody vetted,
 * so the same safety headers as `/api/files/:id/content` decide inline vs
 * download and sandbox them.
 */

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import {
  badRequest,
  baseName,
  browseFail,
  placeAndPath,
  unauthenticated,
} from "@/lib/browse/bff";
import { applyFileSafetyHeaders } from "@/lib/http/file-headers";

export async function GET(req: Request): Promise<Response> {
  if (!(await getPrincipal())) return unauthenticated();
  const sp = new URL(req.url).searchParams;
  const target = placeAndPath(
    { place: sp.get("place"), path: sp.get("path") },
    { pathRequired: true },
  );
  if (!target) return badRequest();
  const download = sp.get("download") === "1";
  try {
    const client = await apiClientForRequest();
    const upstream = await client.browseFile(target.place, target.path);
    const out = new Headers();
    for (const name of ["content-type", "content-length"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    out.set("cache-control", "private, no-store");
    applyFileSafetyHeaders(out, { filename: baseName(target.path), download });
    return new Response(upstream.body, { status: 200, headers: out });
  } catch (err) {
    return browseFail(err);
  }
}

/**
 * GET /api/projects/:slug/artifacts/:artifactId/content — open one produced
 * file. The bytes are piped through the BFF (the Python layer is not
 * reachable from the browser); the upstream checks the project read gate
 * and serves only files a card of this project produced. An agent can write
 * any file (HTML included), so the inline/download decision and the sandbox
 * headers are made here, not taken from upstream.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import {
  applyFileSafetyHeaders,
  filenameFromDisposition,
} from "@/lib/http/file-headers";

const PASSED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; artifactId: string }> },
): Promise<Response> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { slug, artifactId } = await params;
  try {
    const client = await apiClientForRequest();
    const upstream = await client.projectArtifactContent(
      slug,
      artifactId,
      req.headers.get("range"),
    );
    const out = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    out.set("cache-control", "private, no-store");
    applyFileSafetyHeaders(out, {
      filename: filenameFromDisposition(upstream.headers.get("content-disposition")),
      download: new URL(req.url).searchParams.get("download") === "1",
    });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.status === 404 ? "That file is no longer available." : "That file could not be opened." },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}

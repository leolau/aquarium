/**
 * Stream an upstream object's bytes back to the browser.
 *
 * The signed URLs the Python layer mints point at the Supabase instance as the
 * *server* knows it — on the box that is `http://127.0.0.1:8000`, a loopback
 * address no phone or laptop can ever open, and the bucket is deliberately not
 * exposed publicly. So a redirect to a signed URL is only correct when the
 * browser and the server share a network; here they do not. The BFF fetches the
 * object itself and pipes it, which keeps the signed URL (and the storage host)
 * server-side and works no matter where Supabase lives.
 *
 * Range requests are forwarded and the range headers passed back, because a
 * `<video>`/`<audio>` element seeks with `Range` and a response that answers
 * 200-with-everything makes seeking impossible on some browsers.
 *
 * The bytes are untrusted (a stranger's attachment, an agent-written file), so
 * {@link applyFileSafetyHeaders} decides inline vs download and sandboxes them.
 */
import "server-only";

import { applyFileSafetyHeaders } from "@/lib/http/file-headers";

/** Conditional/partial-read headers that must reach the storage backend. */
const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
];

/** Headers that describe the bytes and must survive the hop. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export async function proxyBytes(
  request: Request,
  upstreamUrl: string,
  opts: { filename?: string; download?: boolean } = {},
): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(upstreamUrl, {
    headers,
    cache: "no-store",
    redirect: "follow",
  });

  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
  // The bytes are per-principal: a shared cache must never keep them, and the
  // signed URL behind them expires anyway.
  out.set("cache-control", "private, no-store");
  applyFileSafetyHeaders(out, opts);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

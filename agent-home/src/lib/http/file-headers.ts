/**
 * Response headers for user- or agent-supplied file bytes served on the
 * agent-home origin (the file, chat-media and project-artifact proxies).
 *
 * The bytes are untrusted: an inbound WhatsApp/email attachment from a
 * stranger, or a file an agent wrote. If `.html`/`.svg` bytes were rendered
 * inline on this origin, their script would run with the viewer's session.
 * So every such response:
 *
 * - sends `nosniff`, so the browser never guesses "this is HTML";
 * - carries a sandboxing CSP, so even a document that does render gets an
 *   opaque origin and no script;
 * - opens inline only for types a browser shows without running script
 *   (raster images, audio/video, PDF, plain text); everything else downloads.
 *
 * `<img>`/`<video>` embeds ignore `Content-Disposition`, so in-app previews
 * keep working for every type.
 */

export const FILE_RESPONSE_CSP =
  "sandbox; default-src 'none'; img-src 'self' data: blob:; " +
  "media-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'";

const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/x-m4a",
  "application/pdf",
  "text/plain",
]);

/** `image/PNG; charset=x` → `image/png`; empty when absent. */
export function essenceOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** Whether a browser may open this type inline on our origin. SVG, HTML,
 *  XML and anything unknown are never inline. */
export function isInlineSafe(contentType: string | null | undefined): boolean {
  return INLINE_SAFE_TYPES.has(essenceOf(contentType));
}

/**
 * The filename is sent both as a quoted ASCII fallback and RFC 5987
 * `filename*`, so non-Latin names survive without breaking older clients.
 */
export function contentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The filename an upstream `Content-Disposition` names, if any. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/.exec(header);
  const value = plain ? (plain[1] ?? plain[2])?.trim() : null;
  return value || null;
}

/**
 * Set the safety headers on `headers` (mutated): `nosniff`, the sandbox CSP,
 * and a `Content-Disposition` that is `inline` only when the caller did not
 * ask to download AND the type is on the safe list. A missing content type
 * becomes `application/octet-stream` so nothing is left to guessing.
 */
export function applyFileSafetyHeaders(
  headers: Headers,
  opts: { filename?: string | null; download?: boolean } = {},
): Headers {
  const type = headers.get("content-type");
  if (!essenceOf(type)) headers.set("content-type", "application/octet-stream");
  const inline = !opts.download && isInlineSafe(type);
  headers.set(
    "content-disposition",
    contentDisposition(inline ? "inline" : "attachment", opts.filename || "file"),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", FILE_RESPONSE_CSP);
  headers.set("cross-origin-resource-policy", "same-origin");
  return headers;
}

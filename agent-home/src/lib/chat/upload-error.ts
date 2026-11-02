/**
 * What the browser shows when an upload is refused: the server's `detail`
 * plus the HTTP status and error code, never a bare "Upload failed.", and
 * safe for empty or non-JSON answers (a proxy error page, a crash).
 */
type ErrorBody = { error?: unknown; detail?: unknown };

function parse(text: string): ErrorBody | null {
  if (!text) return null;
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" ? (body as ErrorBody) : null;
  } catch {
    return null;
  }
}

export function uploadFailureMessage(fileName: string, status: number, text: string): string {
  const body = parse(text);
  const code = typeof body?.error === "string" && body.error ? body.error : null;
  const detail = typeof body?.detail === "string" && body.detail.trim() ? body.detail.trim() : null;
  const what =
    detail ??
    (body
      ? "Upload failed."
      : text.trim()
        ? "Upload failed: the server sent an unexpected response."
        : "Upload failed: the server sent no details.");
  return `${fileName}: ${what} (HTTP ${status}${code ? `, ${code}` : ""})`;
}

/** Read a response body as JSON; null for an empty or non-JSON body. */
export function parseJsonObject<T>(text: string): T | null {
  return parse(text) as T | null;
}

/** Human detail for a multipart body the server could not read. */
export const INVALID_FORM_DETAIL =
  "The upload arrived incomplete or malformed, so the server could not read the file. Please try again.";

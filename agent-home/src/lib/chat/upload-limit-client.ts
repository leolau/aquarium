"use client";

/**
 * The upload size limit as the browser sees it (Settings → Uploads via
 * `GET /api/settings/uploads`), fetched once per page load. Null when it
 * cannot be read — the server enforces the limit regardless.
 */
let cached: Promise<number | null> | null = null;

export function uploadLimitBytes(): Promise<number | null> {
  cached ??= fetch("/api/settings/uploads")
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as {
        max_bytes?: unknown;
        legacy_override_bytes?: unknown;
      };
      const value = body.legacy_override_bytes ?? body.max_bytes;
      return typeof value === "number" && value > 0 ? value : null;
    })
    .catch(() => null)
    .then((value) => {
      if (value === null) cached = null;
      return value;
    });
  return cached;
}

/** Test hook: forget the cached limit. */
export function __resetUploadLimit(): void {
  cached = null;
}

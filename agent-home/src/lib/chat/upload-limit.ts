/**
 * Upload size limit, shared by the BFF upload routes and the composer's
 * pre-check (client-safe: no server imports here).
 *
 * The limit is a Settings value (owner/admin, Settings → Uploads), stored in
 * the default profile's config.yaml as `agent_home.uploads.max_bytes` and
 * served with `/api/capacity/upload-storage`; 1 GB when unset.
 * `AGENT_HOME_UPLOAD_MAX_BYTES` is a legacy deploy override that wins when set.
 */
export const DEFAULT_UPLOAD_MAX_BYTES = 1024 ** 3;

/** The legacy env override, or null when unset/invalid. */
export function legacyUploadMaxBytes(): number | null {
  const raw = Number(process.env.AGENT_HOME_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The limit in force given the configured value (from the API, maybe absent). */
export function resolveUploadMaxBytes(configured: unknown): number {
  const legacy = legacyUploadMaxBytes();
  if (legacy !== null) return legacy;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_UPLOAD_MAX_BYTES;
}

/**
 * Advisory threshold: the composer asks before uploading files bigger than
 * this, since they take a while. Not a refusal.
 */
export const UPLOAD_WARN_BYTES = 100 * 1024 * 1024;

/** "1 GB", "250 MB" — whole units, rounded up. */
export function formatUploadLimit(maxBytes: number): string {
  const gb = maxBytes / 1024 ** 3;
  if (gb >= 1) return `${Number((Math.ceil(gb * 10) / 10).toFixed(1))} GB`;
  return `${Math.ceil(maxBytes / (1024 * 1024))} MB`;
}

export function uploadTooLargeDetail(maxBytes: number): string {
  return `File exceeds the ${formatUploadLimit(maxBytes)} upload limit.`;
}

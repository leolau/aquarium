/**
 * Browser-side calls for the FG-37 secret popup. Values go straight from the
 * popup to the BFF over HTTPS and never into chat text, storage or logs; the
 * errors thrown here carry a code only, never the server's text or the value.
 */
import { withProfileBody } from "@/lib/chat/profile";

/** Credential name rule shared with the Python store (`provider="secret"`). */
export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Lower-case, dash-separated slug of whatever was typed (may still be empty). */
export function slugifySecretName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

/** Composer token that refers to a stored secret by name. */
export function secretRef(name: string): string {
  return `[secret: ${name}]`;
}

/** Whole seconds until `expiresAt` (epoch seconds); null when there is no expiry. */
export function secondsLeft(expiresAt: number | null, nowMs: number): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.floor(expiresAt - nowMs / 1000));
}

/** `m:ss` countdown text. */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Why a submit failed, by HTTP status (the UI maps it to a translated line). */
export type SecretErrorCode = "gone" | "forbidden" | "answered" | "invalid" | "failed";

export class SecretSubmitError extends Error {
  constructor(readonly code: SecretErrorCode) {
    super(code);
    this.name = "SecretSubmitError";
  }
}

export function errorCodeForStatus(status: number): SecretErrorCode {
  if (status === 404) return "gone";
  if (status === 403) return "forbidden";
  if (status === 409) return "answered";
  if (status === 400 || status === 422) return "invalid";
  return "failed";
}

async function post(url: string, init: RequestInit): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new SecretSubmitError("failed");
  }
  if (!res.ok) throw new SecretSubmitError(errorCodeForStatus(res.status));
}

/** Answer a `secret.request`: store `values`, or decline. */
export async function answerSecretRequest(params: {
  requestId: string;
  values?: Record<string, string>;
  decline?: boolean;
  profile?: string;
}): Promise<void> {
  const body = params.decline
    ? { request_id: params.requestId, decline: true }
    : { request_id: params.requestId, values: params.values ?? {} };
  await post("/api/chat/secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withProfileBody(body, params.profile)),
  });
}

/** Save a volunteered secret under `name` (Settings → Connected accounts store). */
export async function saveVolunteeredSecret(name: string, value: string): Promise<void> {
  await post(`/api/credentials/secret/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "secret", payload: { value }, visibility: "private" }),
  });
}

/** `text` with `[secret: name]` inserted at `at` (clamped), spaced from its neighbours. */
export function insertSecretRef(text: string, at: number, name: string): string {
  const pos = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return `${before}${lead}${secretRef(name)}${trail}${after}`;
}

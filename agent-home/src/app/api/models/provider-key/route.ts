/**
 * POST /api/models/provider-key — validate then persist a provider API key.
 * Body: { key, value } where `key` is the provider's env var name (from the
 * picker row's `key_env`, e.g. `OPENCODE_GO_API_KEY`).
 *
 * Flow: `POST /api/providers/validate` first — a confirmed-bad key
 * (`ok:false` + `reachable:true`) is refused with the upstream message.
 * An unreachable probe (`reachable:false`) doesn't block: providers without
 * a live probe (opencode-go among them) can't be pre-verified, so the key
 * is saved and the real test is whether the provider's catalog loads.
 *
 * DELETE /api/models/provider-key — body { key } removes the env var,
 * disconnecting the provider. Slots pinned to it fall back to `auto`.
 *
 * Secrets: the value travels request → upstream `.env` write only. It is
 * never logged or echoed back.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function errorBody(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json(
      { error: "api_error", detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}

async function readKeyBody(request: Request): Promise<{
  key: string;
  value: string;
  extra_env?: Record<string, string>;
  profile?: string;
} | null> {
  try {
    const body = (await request.json()) as {
      key?: unknown;
      value?: unknown;
      extra_env?: unknown;
      profile?: unknown;
    };
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    const profile = typeof body.profile === "string" ? body.profile : undefined;
    // Companion writes (e.g. the provider's endpoint-URL env var) saved
    // alongside the key so providers that need both activate in one step.
    const extra_env: Record<string, string> = {};
    if (body.extra_env && typeof body.extra_env === "object") {
      for (const [k, v] of Object.entries(body.extra_env)) {
        if (typeof v === "string" && v.trim() && ENV_KEY_RE.test(k)) {
          extra_env[k] = v.trim();
        }
      }
    }
    return { key, value, extra_env, profile };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: ADMIN_ONLY_DENIED },
      { status: 403 },
    );
  }
  const body = await readKeyBody(request);
  if (!body || !ENV_KEY_RE.test(body.key) || !body.value.trim()) {
    return NextResponse.json(
      { error: "bad_request", detail: "A valid env var name and key value are required." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: body.profile });
    const probe = await client.validateProviderKey(body.key, body.value.trim());
    // Confirmed-bad keys are refused; unreachable probes fall through to save
    // (the picker surfaces the distinction so the save isn't silently trusted).
    if (!probe.ok && probe.reachable) {
      return NextResponse.json(
        { error: "invalid_key", detail: probe.message || "That API key was rejected." },
        { status: 400 },
      );
    }
    const saved = await client.setEnvVar(body.key, body.value.trim());
    for (const [extraKey, extraValue] of Object.entries(body.extra_env ?? {})) {
      await client.setEnvVar(extraKey, extraValue);
    }
    return NextResponse.json({
      ...saved,
      verified: probe.reachable === true,
    });
  } catch (err) {
    return errorBody(err);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: ADMIN_ONLY_DENIED },
      { status: 403 },
    );
  }
  const body = await readKeyBody(request);
  if (!body || !ENV_KEY_RE.test(body.key)) {
    return NextResponse.json(
      { error: "bad_request", detail: "A valid env var name is required." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: body.profile });
    const data = await client.deleteEnvVar(body.key);
    return NextResponse.json(data);
  } catch (err) {
    return errorBody(err);
  }
}

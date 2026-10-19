/**
 * POST /api/session/language — switch the interface language.
 *
 * Public on purpose: the login and /setup pages offer the switcher before
 * anyone is signed in, and then only this browser's copy is set. When a
 * session exists the choice is also saved server-side for that person (the
 * Python API derives who from the session; no user id is accepted here).
 */
import { NextResponse } from "next/server";

import { isLocale } from "@/i18n/config";
import { setLocaleCookie } from "@/i18n/server";
import { HermesApiClient } from "@/lib/api/client";
import { readSession } from "@/lib/auth/session";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { language?: unknown } | null;
  const language = body?.language;
  if (!isLocale(language)) {
    return NextResponse.json({ error: "unsupported_language" }, { status: 400 });
  }
  await setLocaleCookie(language);
  const session = await readSession();
  if (!session?.hermesToken) {
    return NextResponse.json({ language, saved: false });
  }
  try {
    await new HermesApiClient({ hermesToken: session.hermesToken }).setMyLanguage(language);
    return NextResponse.json({ language, saved: true });
  } catch {
    return NextResponse.json({ error: "save_failed", language, saved: false }, { status: 502 });
  }
}

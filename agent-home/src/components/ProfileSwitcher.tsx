"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ProfilePicker } from "@/components/chat/ProfilePicker";
import { useAction } from "@/lib/use-action";
import type { ProfileSummary } from "@/types";

/**
 * Ask the session to work in `profile` (FG-28 B3). The server re-derives the
 * principal there and refuses an unenrolled profile, leaving the session as it
 * was; the answer's `detail` explains a refusal.
 */
export async function switchSessionProfile(
  profile: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/session/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    return { ok: false, error: body?.detail ?? `You can't work in ${profile}.` };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/**
 * The URL to show after a switch: the same page, minus what named the old
 * profile's data (`?profile=`, and `?session=` — a conversation id belongs to
 * one profile's history).
 */
export function urlAfterSwitch(href: string): string {
  const url = new URL(href, "http://n");
  url.searchParams.delete("profile");
  url.searchParams.delete("session");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The header's profile switcher (FG-28 B3): which profile this whole session
 * works in — chat, the members console and every page after. Fed by the
 * account's active enrolments, so it renders nothing for someone enrolled in a
 * single profile (the common case) and never offers one they aren't in.
 */
export function ProfileSwitcher({
  profiles,
  current,
}: {
  profiles: ProfileSummary[];
  current: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // One switch at a time: a second pick while the first is in flight is dropped.
  const { run: select, pending: busy } = useAction(async (next: string) => {
    if (next === current) return;
    setError(null);
    const result = await switchSessionProfile(next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => {
      router.replace(urlAfterSwitch(window.location.href));
      router.refresh();
    });
  });

  if (profiles.length < 2) return null;
  return (
    <div data-component="ProfileSwitcher" className="min-w-0">
      <ProfilePicker
        profiles={profiles}
        selected={current}
        onSelect={(p) => void select(p)}
        switching={busy || pending}
        compact
      />
      {error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

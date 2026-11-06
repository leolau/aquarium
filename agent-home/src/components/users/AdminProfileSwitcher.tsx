"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ProfilePicker } from "@/components/chat/ProfilePicker";
import { useAction } from "@/lib/use-action";
import type { ProfileSummary } from "@/types";

/**
 * The Users screen for `profile`, keeping the rest of the URL. The session is
 * left alone: administering `hr` from here does not make the session (chat,
 * every other page) work in `hr` — that is the header switcher's job.
 */
export function usersHref(href: string, profile: string): string {
  const url = new URL(href, "http://n");
  url.searchParams.set("profile", profile);
  return `/users${url.search}`;
}

/**
 * Which profile the Users screen administers (FG-28 C3). Offers only the
 * profiles the account is owner/admin of, so it renders nothing for someone
 * administering one profile (the common case). The choice lives in the URL
 * (`/users?profile=`); the page re-validates it and every members request
 * names it, so the BFF and Python decide the role in that profile.
 */
export function AdminProfileSwitcher(props: { profiles: ProfileSummary[]; current: string }) {
  return props.profiles.length < 2 ? null : <Switcher {...props} />;
}

function Switcher({ profiles, current }: { profiles: ProfileSummary[]; current: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { run: select, pending: busy } = useAction(async (next: string) => {
    if (next === current) return;
    startTransition(() => router.push(usersHref(window.location.href, next)));
  });

  return (
    <div data-component="AdminProfileSwitcher" className="min-w-0">
      <ProfilePicker
        profiles={profiles}
        selected={current}
        onSelect={(p) => void select(p)}
        switching={busy || pending}
        compact
        id="users-admin-profile"
        label="Administering"
      />
    </div>
  );
}

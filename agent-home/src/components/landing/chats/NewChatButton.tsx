"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DEFAULT_PROFILE } from "@/components/chat/ProfilePicker";
import { switchSessionProfile } from "@/components/ProfileSwitcher";
import { useAction } from "@/lib/use-action";
import type { ProfileSummary } from "@/types";

import { chatHref, chatsApi } from "./chatsApi";
import { ChevronDownIcon, PlusIcon, UserIcon } from "./icons";

export function profileLabel(name: string): string {
  return name === DEFAULT_PROFILE ? "Default" : name;
}

/**
 * "New chat" plus the profile it starts in (Figma `new-chat-row`, component
 * `profile-select` 4:29). Defaults to the session's profile; picking another
 * switches the session first (a profile is a whole HERMES_HOME), then
 * `POST /api/chat/new` creates the conversation and the chat page opens it.
 * Like `ProfilePicker`, the selector is hidden with fewer than two profiles.
 */
export function NewChatButton({
  currentProfile = DEFAULT_PROFILE,
  profiles,
  onStarted,
  fetchImpl = fetch,
  id = "landing-new-chat-profile",
}: {
  currentProfile?: string;
  profiles: ProfileSummary[];
  onStarted?: () => void;
  fetchImpl?: typeof fetch;
  id?: string;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(currentProfile);
  const [error, setError] = useState<string | null>(null);

  const start = useAction(async () => {
    setError(null);
    if (profile !== currentProfile) {
      const switched = await switchSessionProfile(profile);
      if (!switched.ok) {
        setError(switched.error);
        return;
      }
    }
    const res = await chatsApi.newChat(profile, fetchImpl);
    onStarted?.();
    if (res.ok && res.data?.session_id) {
      router.push(chatHref(res.data.session_id, undefined));
    } else if (!res.ok && !res.unsupported) {
      setError(res.error);
    } else {
      router.push("/chat?new=1");
    }
  });

  const showPicker = profiles.length > 1;
  const differs = profile !== currentProfile;

  return (
    <div data-component="NewChatButton" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void start.run()}
          disabled={start.pending}
          aria-busy={start.pending || undefined}
          className="inline-flex min-w-0 flex-1 lg:!min-h-0 items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-3 py-2 text-[13px] font-medium leading-[18px] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-60"
        >
          <PlusIcon size={16} />
          {start.pending ? "Starting…" : "New chat"}
        </button>
        {showPicker ? (
          <div
            data-component="ProfileSelect"
            className="relative inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-xs font-medium text-[var(--color-fg)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]"
          >
            <UserIcon size={14} className="shrink-0 text-[var(--color-muted)]" />
            <span aria-hidden="true" className="truncate">
              {profileLabel(profile)}
            </span>
            <ChevronDownIcon size={14} className="shrink-0 text-[var(--color-muted)]" />
            <label htmlFor={id} className="sr-only">
              Profile for the new chat
            </label>
            <select
              id={id}
              value={profile}
              disabled={start.pending}
              onChange={(e) => setProfile(e.target.value)}
              className="absolute inset-0 !min-h-0 cursor-pointer opacity-0"
            >
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {profileLabel(p.name)}
                  {p.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {differs ? (
        <span className="px-1 text-xs text-[var(--color-accent)]">
          Starting in {profileLabel(profile)}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="px-1 text-xs text-[var(--color-danger)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}

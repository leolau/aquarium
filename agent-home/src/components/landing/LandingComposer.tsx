"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { AquariumLoader } from "@/components/brand/AquariumLoader";
import type { ProfileSummary } from "@/types";

import { chatHandOffUrl, greetingFor } from "./startChat";

export const LANDING_SUGGESTIONS = [
  "What did my agents get done today?",
  "What needs my attention?",
  "Plan a new project with me",
  "Pick up where I left off",
] as const;

/**
 * The centre of the landing page (Figma `composer` 4:36): greeting, a large
 * message box and suggestion chips. Sending starts a new chat in the chosen
 * profile and opens it on the chat page with the message already sent.
 */
export function LandingComposer({
  profiles,
  currentProfile,
  needsYouCount = 0,
  name,
}: {
  profiles: ProfileSummary[];
  currentProfile: string;
  needsYouCount?: number;
  name?: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [profile, setProfile] = useState(currentProfile);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Server and browser clocks can differ by an hour boundary; the h1
  // tolerates that mismatch rather than flashing a placeholder.
  const greeting = greetingFor(new Date().getHours());
  const trimmed = text.trim();

  async function submit() {
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      if (profile !== currentProfile) {
        // A profile is a whole HERMES_HOME: switch the session first so the
        // chat page, its history and the reply all belong to it.
        const res = await fetch("/api/session/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        if (!res.ok) throw new Error(`Couldn't switch to ${profile}.`);
      }
      router.push(chatHandOffUrl(trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the chat.");
      setPending(false);
    }
  }

  const hello = name ? `${greeting}, ${name}` : greeting;
  const subline =
    needsYouCount > 0
      ? `${needsYouCount} ${needsYouCount === 1 ? "thing needs" : "things need"} you`
      : "What should we work on?";

  return (
    <section data-component="LandingComposer" className="flex w-full max-w-2xl flex-col items-center gap-6">
      <div className="text-center">
        <h1 suppressHydrationWarning className="text-2xl font-semibold tracking-tight lg:text-3xl">{hello}</h1>
        <p
          data-testid="landing-subline"
          className={`mt-1 text-sm ${needsYouCount > 0 ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"}`}
        >
          {subline}
        </p>
      </div>

      <form
        className="w-full rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm focus-within:border-[var(--color-accent)]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="landing-message" className="sr-only">
          Message
        </label>
        <textarea
          id="landing-message"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder="Ask anything, or describe a task…"
          disabled={pending}
          className="w-full resize-none bg-transparent px-2 py-1 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          {profiles.length > 1 ? (
            <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-muted)]">
              <span className="shrink-0">Profile</span>
              <select
                aria-label="Profile for the new chat"
                value={profile}
                disabled={pending}
                onChange={(e) => setProfile(e.target.value)}
                className="min-w-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text)]"
              >
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.is_default ? " (default)" : ""}
                  </option>
                ))}
              </select>
              {profile !== currentProfile ? (
                <span className="truncate text-[var(--color-accent)]">Starting in {profile}</span>
              ) : null}
            </label>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={!trimmed || pending}
            aria-label={pending ? "Starting chat" : "Start chat"}
            className="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-full bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
          >
            {pending ? <AquariumLoader size={20} label="Starting chat…" /> : "Send"}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <ul aria-label="Suggestions" className="flex flex-wrap justify-center gap-2">
        {LANDING_SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => {
                setText(s);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

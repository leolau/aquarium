"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { switchSessionProfile, urlAfterSwitch } from "@/components/ProfileSwitcher";
import { Spinner } from "@/components/ui/Spinner";

/**
 * A link named a profile other than the session's (`/chat?profile=hr`): switch
 * the session there, then re-render the page in it. A refused switch (not
 * enrolled, suspended) says so and stays in the current profile — the page is
 * never rendered under a profile the session does not hold.
 */
export function SwitchOnArrival({ profile, current }: { profile: string; current: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void switchSessionProfile(profile).then((result) => {
      if (result.ok) {
        const url = new URL(window.location.href);
        url.searchParams.delete("profile");
        router.replace(`${url.pathname}${url.search}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }, [profile, router]);

  if (error) {
    return (
      <section
        data-component="ProfileSwitchRefused"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center"
      >
        <p role="alert" className="text-base font-medium">
          Couldn&apos;t open {profile}: {error}
        </p>
        <Link
          href={urlAfterSwitch(typeof window === "undefined" ? "/chat" : window.location.href)}
          className="mt-4 inline-block rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          Stay in {current}
        </Link>
      </section>
    );
  }
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
      <Spinner />
      Switching to {profile}…
    </p>
  );
}

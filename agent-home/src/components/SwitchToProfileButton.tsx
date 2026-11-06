"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { switchSessionProfile } from "@/components/ProfileSwitcher";
import { useAction } from "@/lib/use-action";

/** Switch the session to `profile` and re-render the page the user is on. */
export function SwitchToProfileButton({ profile }: { profile: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { run, pending: busy } = useAction(async () => {
    setError(null);
    const result = await switchSessionProfile(profile);
    if (result.ok) router.refresh();
    else setError(result.error);
  });
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        Switch to {profile}
      </button>
      {error ? (
        <p role="alert" className="w-full text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </>
  );
}

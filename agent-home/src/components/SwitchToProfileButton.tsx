"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { switchSessionProfile } from "@/components/ProfileSwitcher";
import { Spinner } from "@/components/ui/Spinner";
import { useAction } from "@/lib/use-action";

/**
 * Switch the session to `profile` and re-render the page the user is on.
 * Locks on the first press and stays busy until the refreshed page lands.
 */
export function SwitchToProfileButton({
  profile,
  label,
  busyLabel,
  className = "rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium disabled:opacity-60",
}: {
  profile: string;
  label?: string;
  busyLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const { run, pending } = useAction(async () => {
    setError(null);
    const result = await switchSessionProfile(profile);
    if (result.ok) {
      setLeaving(true);
      router.refresh();
    } else setError(result.error);
  });
  const busy = pending || leaving;
  return (
    <>
      <button
        type="button"
        data-action="switch-profile"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void run()}
        className={className}
      >
        {busy && busyLabel ? (
          <>
            <Spinner /> {busyLabel}
          </>
        ) : (
          (label ?? `Switch to ${profile}`)
        )}
      </button>
      {error ? (
        <p role="alert" className="w-full text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </>
  );
}

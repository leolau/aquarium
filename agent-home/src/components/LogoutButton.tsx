"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";

/** Clears the `agent-home` session then returns to the login page. */
export function LogoutButton() {
  const t = useT("common");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function signOut() {
    setConfirming(false);
    setBusy(true);
    try {
      await fetch("/api/session/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  // The lock outlives the dialog, which closes as soon as sign-out starts.
  const { run: signOutOnce } = useAction(signOut);

  return (
    <>
      <button
        data-component="LogoutButton"
        type="button"
        disabled={busy}
        onClick={() => setConfirming(true)}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-3 text-center text-sm text-[var(--color-muted)] disabled:opacity-60"
      >
        {busy ? (
          <>
            <Spinner />
            {t("signingOut")}
          </>
        ) : (
          t("signOut")
        )}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t("signOutConfirmTitle")}
          body={t("signOutConfirmBody")}
          confirmLabel={t("signOut")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => signOutOnce()}
        />
      )}
    </>
  );
}

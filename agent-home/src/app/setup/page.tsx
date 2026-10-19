import type { Metadata } from "next";

import { SetupOwnerForm } from "@/components/auth/SetupOwnerForm";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { MobileShell } from "@/components/MobileShell";
import { getT } from "@/i18n/server";
import { HermesApiClient } from "@/lib/api/client";

/**
 * First-run owner setup, opened from the link `hermes setup-link` prints
 * (`/setup#token=…`). **Unauthenticated on purpose**: the owner has no login
 * yet. The token is in the URL fragment, which the browser never sends to a
 * server, so it stays out of Caddy and Next.js logs; the form reads it in the
 * browser and posts it. `noindex` here plus `Referrer-Policy: no-referrer` for
 * `/setup` in `next.config.mjs`.
 */
export const metadata: Metadata = {
  title: "Set up Aquarium",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const t = await getT("setup");
  const common = await getT("common");
  // Which password login to sign the new owner into, for the optional
  // two-factor step. An unreachable API just skips that step.
  const providers = await new HermesApiClient()
    .authProviders()
    .then((res) => res.providers)
    .catch(() => []);
  return (
    <MobileShell title={t("title")} showCoral={false}>
      <div className="mb-4 flex flex-col gap-1 text-sm">
        <span className="text-[var(--color-muted)]">{common("language")}</span>
        <LanguageSwitch showNote />
      </div>
      <SetupOwnerForm providers={providers} />
    </MobileShell>
  );
}

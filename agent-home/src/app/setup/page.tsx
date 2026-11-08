import type { Metadata } from "next";

import { SetupOwnerForm } from "@/components/auth/SetupOwnerForm";
import { AuthLayout } from "@/components/auth/AuthLayout";
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
  // The sign-in provider "Finish setup" uses; an unreachable API still lets the
  // owner be created (they then sign in from /login).
  const providers = await new HermesApiClient()
    .authProviders()
    .then((res) => res.providers)
    .catch(() => []);
  return (
    <AuthLayout wide component="SetupPage">
      <SetupOwnerForm providers={providers} />
    </AuthLayout>
  );
}

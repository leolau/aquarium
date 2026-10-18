import type { Metadata } from "next";

import { SetupOwnerForm } from "@/components/auth/SetupOwnerForm";
import { MobileShell } from "@/components/MobileShell";

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

export default function Page() {
  return (
    <MobileShell title="Set up Aquarium" showCoral={false}>
      <SetupOwnerForm />
    </MobileShell>
  );
}

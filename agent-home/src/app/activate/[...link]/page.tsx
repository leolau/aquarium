import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ActivateForm } from "@/components/auth/ActivateForm";
import { MobileShell } from "@/components/MobileShell";
import { parseActivationLink } from "@/lib/auth/activation-link";

/**
 * `noindex, nofollow` — the URL *is* the credential until it is redeemed, so it
 * must not end up in a search index or be followed by a crawler. The
 * `Referrer-Policy: no-referrer` half of the protection is set for
 * `/activate/:path*` in `next.config.mjs`, since a header cannot be declared
 * here.
 */
export const metadata: Metadata = {
  title: "Activate your account",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * FG-26 activation, at `/activate/<token>` (default profile) or
 * `/activate/<profile>/<token>` (FG-28 C2; one catch-all route because Next
 * refuses two differently named dynamic segments at the same level).
 * **Unauthenticated on purpose**: somebody setting their
 * first password has no session yet, and the invitation is what authorises
 * them. The Coral launcher is hidden (`showCoral={false}`) because there is nothing else
 * they can reach yet.
 *
 * The page renders the form without asking the server whether the token is
 * valid. A pre-flight check would answer "does this token exist?" to anybody
 * who asks — exactly the oracle the redeem endpoint's identical failure
 * responses are designed to deny.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ link: string[] }>;
}) {
  const link = parseActivationLink((await params).link.map(decodeURIComponent));
  if (!link) notFound();
  return (
    <MobileShell title="Activate your account" showCoral={false}>
      <ActivateForm token={link.token} profile={link.profile} />
    </MobileShell>
  );
}

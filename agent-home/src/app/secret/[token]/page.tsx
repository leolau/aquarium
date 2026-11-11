import type { Metadata } from "next";
import { headers } from "next/headers";

import { AuthCard, AuthLayout } from "@/components/auth/AuthLayout";
import { SecretLinkForm, SecretLinkUnusable } from "@/components/secret-link/SecretLinkForm";
import { HermesApiClient } from "@/lib/api/client";
import { callerIpFromHeaders } from "@/lib/api/callerIp";
import type { SecretLinkInfo } from "@/types";

/**
 * `noindex` + `Referrer-Policy: no-referrer` + `no-store` (set for
 * `/secret/:path*` in `next.config.mjs`): the URL is a live credential until it
 * is used, so it must not reach a search index, a cache or the next site's
 * referrer header.
 */
export const metadata: Metadata = {
  title: "Secure secret entry",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

async function linkInfo(token: string): Promise<SecretLinkInfo | null> {
  try {
    return await new HermesApiClient().secretLinkInfo(token, callerIpFromHeaders(await headers()));
  } catch {
    // Unknown, used, expired, throttled or unreachable: one neutral card.
    return null;
  }
}

/**
 * FG-37 one-time secret link, at `/secret/<token>`. **Unauthenticated on
 * purpose**: the agent sent this link into the person's own WhatsApp,
 * Telegram or email chat, and the token is what authorises them. The value is
 * stored in that person's credential store; the agent only learns its name.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await linkInfo(token);
  return (
    <AuthLayout component="SecretLinkPage">
      <AuthCard>
        {info ? <SecretLinkForm token={token} info={info} /> : <SecretLinkUnusable />}
      </AuthCard>
    </AuthLayout>
  );
}

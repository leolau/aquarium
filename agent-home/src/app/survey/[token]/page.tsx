import type { Metadata } from "next";
import { headers } from "next/headers";

import { SeminarShell, SurveyLinkInvalid, SurveyThanks } from "@/components/seminar/SeminarShell";
import { SurveyForm } from "@/components/seminar/SurveyForm";
import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { callerIpFromHeaders } from "@/lib/api/callerIp";

/**
 * `noindex` + `Referrer-Policy: no-referrer` (set for `/survey/:path*` in
 * `next.config.mjs`): the link identifies one attendee and must not end up in a
 * search index or in the next site's referrer header.
 */
export const metadata: Metadata = {
  title: "AI&I 講座問卷 Seminar survey",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

type LinkState = "open" | "submitted" | "unknown";

async function linkState(token: string): Promise<LinkState> {
  try {
    const state = await new HermesApiClient().seminarSurveyState(
      token,
      callerIpFromHeaders(await headers()),
    );
    return state.submitted ? "submitted" : "open";
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) return "unknown";
    // Upstream trouble: show the form; submitting reports the real error.
    return "open";
  }
}

/**
 * The seminar survey. **Unauthenticated on purpose**: attendees have no
 * account. The personal link WhatsApp triage's outreach worker sent into their
 * chat is what identifies them, and the slides go back to that chat once the
 * answers are in.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const state = await linkState(token);
  return (
    <SeminarShell>
      {state === "submitted" ? <SurveyThanks /> : null}
      {state === "unknown" ? <SurveyLinkInvalid /> : null}
      {state === "open" ? <SurveyForm token={token} /> : null}
    </SeminarShell>
  );
}

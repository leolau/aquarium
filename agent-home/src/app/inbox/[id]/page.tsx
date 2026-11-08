import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { IncomingDetailView } from "@/components/inbox/IncomingDetailView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { IncomingDetail } from "@/types";

// The arrival is C2-scoped, so it is read per request under the live principal.
export const dynamic = "force-dynamic";

/**
 * `/inbox/:id` — one arrival in full.
 *
 * An upstream 404 covers both "no such item" and "not yours"; this page
 * renders the same not-found either way rather than confirming that somebody
 * else's message exists.
 */
/** Only an Inbox query string is a valid Back target (no open redirects). */
function inboxBackHref(from: string | string[] | undefined): string {
  const value = Array.isArray(from) ? from[0] : from;
  return value && value.startsWith("?") && !value.includes("//") ? `/inbox${value}` : "/inbox";
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ from?: string | string[] }>;
}) {
  await requirePrincipal();
  const { id } = await params;

  // The fetch is kept outside the JSX so a render error cannot be mistaken
  // for a missing item and turned into a 404.
  let item: IncomingDetail;
  try {
    const client = await apiClientForRequest();
    item = await client.incoming(id);
  } catch {
    notFound();
  }

  return (
    <MobileShell
      title={
        item.subject?.trim() || item.sender_name?.trim() || item.sender_id?.trim() || "(untitled)"
      }
      back={{ href: inboxBackHref((await searchParams)?.from), label: "Inbox" }}
    >
      <IncomingDetailView item={item} />
    </MobileShell>
  );
}

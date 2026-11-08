import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { InboxView, type Tab } from "@/components/inbox/InboxView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type {
  Change,
  IncomingsFacets,
  IncomingsResponse,
  Notification,
} from "@/types";

// Reads the live principal (cookie) + the caller's C2-scoped inbox per
// request — never at build time.
export const dynamic = "force-dynamic";

const EMPTY_INCOMINGS: IncomingsResponse = { items: [], next_cursor: null };
const EMPTY_FACETS: IncomingsFacets = {
  surfaces: [],
  importance: [],
  tags: [],
};

/**
 * The **Inbox**: everything that arrived (Incomings), plus the FG-10 approvals
 * queue and the FG-12 change log.
 *
 * BFF: the server resolves the principal and loads the C2-scoped first page of
 * arrivals, the filter facets, the pending approvals and the reversible change
 * log, then hands them to the interactive {@link InboxView}.
 *
 * The arrivals load is tolerated separately from the comms load: a box whose
 * registry has never been initialised should still get a working Approvals
 * tab rather than an error page for the whole inbox.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePrincipal();
  const params = await searchParams;
  const requested = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const initialTab: Tab =
    requested === "approvals" || requested === "changes"
      ? requested
      : "incomings";

  // A shared `/inbox?q=…&surface=…` link must arrive already filtered: the
  // client restores the same state from the URL, so filtering only on the
  // client would render the whole inbox for one frame first.
  const first = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? undefined;
  };
  const remembered = first("remembered");
  const hasAttachments = first("has_attachments");

  let configured = false;
  let notifications: Notification[] = [];
  let changes: Change[] = [];
  let incomings: IncomingsResponse = EMPTY_INCOMINGS;
  let facets: IncomingsFacets = EMPTY_FACETS;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const [notifResp, changeResp] = await Promise.all([
      client.notifications(),
      client.changes(),
    ]);
    configured = notifResp.configured && changeResp.configured;
    notifications = notifResp.notifications;
    changes = changeResp.changes;

    try {
      [incomings, facets] = await Promise.all([
        client.incomings({
          limit: 50,
          q: first("q"),
          surface: first("surface"),
          tag: first("tag"),
          exclude_tag: first("exclude_tag"),
          tag_match: first("tag_match"),
          since: first("since"),
          until: first("until"),
          remembered: remembered == null ? undefined : remembered === "true",
          has_attachments:
            hasAttachments == null ? undefined : hasAttachments === "true",
        }),
        client.incomingsFacets(),
      ]);
    } catch {
      // An uninitialised registry means an empty list, not a broken page.
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load the inbox";
  }

  const t = await getT("inbox");
  return (
    <MobileShell
      title="Inbox"
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
    >
      {error ? (
        <div data-component="InboxError">
          <ErrorState kind="error" details={error} />
        </div>
      ) : (
        <InboxView
          initialConfigured={configured}
          initialNotifications={notifications}
          initialChanges={changes}
          initialIncomings={incomings}
          incomingsFacets={facets}
          initialTab={initialTab}
        />
      )}
    </MobileShell>
  );
}

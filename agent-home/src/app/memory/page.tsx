import { MemoryHeaderActions } from "@/components/memory/MemoryHeaderActions";
import { MobileShell } from "@/components/MobileShell";
import { MemoryView } from "@/components/memory/MemoryView";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { loadWhoseData, NO_WHOSE_DATA, type WhoseData } from "@/lib/whose-data";
import type { MemoryRowsResponse, MemorySummary } from "@/types";

// Per-principal HTML — never cached.
export const dynamic = "force-dynamic";

/**
 * FG-23 A2 — the `/memory` tab on `agent-home` (the phone). The first paint is
 * RSC: the server resolves the principal, fetches the summary + first page of
 * rows from the Python API, and renders. Search, paging, the map and query
 * placement are client-side refetches through BFF handlers under
 * `src/app/api/memory/*`.
 *
 * A 409 here means "authenticated, but no principal" — render a plain sentence
 * (an enrolment problem, not a bug) rather than raw JSON.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ document?: string }>;
}) {
  const principal = await requirePrincipal();
  const t = await getT("system");
  // `?document=<id>` arrives from a citation link: open on that document's
  // passages instead of the whole memory list.
  const { document } = await searchParams;
  const documentId = document || null;

  let summary: MemorySummary | null = null;
  let first: MemoryRowsResponse | null = null;
  let error: string | null = null;
  let noPrincipal = false;
  let whose: WhoseData = NO_WHOSE_DATA;

  try {
    const client = await apiClientForRequest();
    whose = await loadWhoseData(client, principal.user_id);
    const owners = whose.owners;
    [summary, first] = await Promise.all([
      client.memorySummary(),
      documentId
        ? client.memoryRows({ limit: 25, kind: "chunk", topic: documentId, owners })
        : client.memoryRows({ limit: 25, owners }),
    ]);
  } catch (err) {
    // The status, not the message: `HermesApiError.message` embeds the request
    // path, so matching the string "409" in it can fire on a path.
    if (err instanceof HermesApiError && err.status === 409) {
      noPrincipal = true;
    } else {
      error = err instanceof Error ? err.message : "Failed to load memory";
    }
  }

  return (
    <MobileShell
      title="Memory"
      subtitle={t("pages.memory.subtitle")}
      wide
      actions={
        noPrincipal || error || !summary || !first ? null : (
          <MemoryHeaderActions />
        )
      }
    >
      {noPrincipal ? (
        <div
          data-component="MemoryNoPrincipal"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Your login isn&apos;t linked to a memory principal yet. Ask the owner
          to enrol you with <code className="font-mono">hermes owner alias</code>.
        </div>
      ) : error || !summary || !first ? (
        <div
          data-component="MemoryError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load memory ({error}).
        </div>
      ) : (
        <MemoryView
          whose={whose}
          summary={summary}
          initialRows={first}
          documentId={documentId}
        />
      )}
    </MobileShell>
  );
}

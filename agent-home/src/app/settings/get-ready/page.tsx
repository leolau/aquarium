import { MobileShell } from "@/components/MobileShell";
import { GetReadyView, type GetReadyExtras } from "@/components/get-ready/GetReadyView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { GetReadyResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Get ready: the P2 checklist (what is set up, what is left) with
 * each item's existing settings block inline. Owner/admin see all eleven
 * items plus each person's connection status; members and viewers see only
 * their own connections. Statuses only, never a key or token.
 */
export default async function Page() {
  await requirePrincipal();
  const client = await apiClientForRequest();

  let data: GetReadyResponse | null = null;
  let error: string | null = null;
  try {
    data = await client.getReady();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  const extras: GetReadyExtras = {
    profile: "default",
    people: null,
    peopleError: null,
    tools: null,
    currentMain: null,
  };
  if (data) {
    const [people, members, mcp, toolsets, model, backups] = await Promise.allSettled([
      data.can_manage ? client.getReadyPeople() : Promise.resolve(null),
      data.can_manage ? client.members({ limit: 1, offset: 0 }) : Promise.resolve(null),
      client.mcpServers(),
      client.toolsets(),
      data.can_manage ? client.modelInfo() : Promise.resolve(null),
      data.role === "owner" ? client.offsiteBackup() : Promise.resolve(null),
    ]);
    if (backups.status === "fulfilled") extras.backups = backups.value;
    if (people.status === "fulfilled") extras.people = people.value;
    else extras.peopleError = "unavailable";
    if (members.status === "fulfilled" && members.value?.profile) extras.profile = members.value.profile;
    if (mcp.status === "fulfilled" && toolsets.status === "fulfilled") {
      extras.tools = { servers: mcp.value.servers, toolsets: toolsets.value };
    }
    if (model.status === "fulfilled" && model.value) {
      extras.currentMain = { provider: model.value.provider, model: model.value.model };
    }
  }

  return (
    <MobileShell title="Get ready" wide>
      {data ? (
        <GetReadyView initial={data} extras={extras} />
      ) : (
        <div
          data-component="GetReadyError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load the checklist ({error}).
        </div>
      )}
    </MobileShell>
  );
}

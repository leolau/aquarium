/**
 * "Whose data" (FG-38 P4): whom the caller may pick, and whose data a page
 * opens on. Loaded on the server with the first page, so the first rows are
 * already narrowed to the caller and nothing depends on a later fetch.
 */
import type { HermesApiClient } from "@/lib/api/client";

export type ViewablePerson = { user_id: string; display: string; role: string };
export type ViewablePeople = { me: string; role_reads: boolean; people: ViewablePerson[] };

/** Most people one `owners=` filter may name (the backend's `MAX_OWNER_FILTER`). */
export const MAX_OWNERS = 50;

export type WhoseData = {
  /** Whom the picker offers; `null` hides it (only yourself, or unknown). */
  roster: ViewablePeople | null;
  /** The `owners=` a page opens on; empty leaves the server's own scope. */
  owners: string[];
};

export const NO_WHOSE_DATA: WhoseData = { roster: null, owners: [] };

/**
 * Who may read only their own data keeps today's view (no `owners=`); anyone
 * who may read other people's opens on just their own. If the roster cannot
 * be loaded the page still opens on the caller alone: narrower, never wider.
 */
export async function loadWhoseData(client: HermesApiClient, me: string): Promise<WhoseData> {
  try {
    const roster = await client.request<ViewablePeople>("/api/access/viewable-people");
    if (!roster || !Array.isArray(roster.people) || roster.people.length < 2) {
      return NO_WHOSE_DATA;
    }
    return { roster, owners: [roster.me] };
  } catch {
    return { roster: null, owners: [me] };
  }
}

/** Whose a row is, for display when the view spans more than the caller. */
export function ownerLabel(
  people: ViewablePeople | null,
  owners: string[],
  ownerUserId: string,
): string | null {
  if (!people || !owners.some((id) => id !== people.me)) return null;
  if (ownerUserId === people.me) return "Me";
  return people.people.find((p) => p.user_id === ownerUserId)?.display ?? ownerUserId;
}

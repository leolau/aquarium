import "server-only";

import type { HermesApiClient } from "@/lib/api/client";
import type { DirectoryEntry } from "@/types";

/** The colleague directory for owner names and the share picker; empty if unreadable. */
export async function loadDirectory(client: HermesApiClient): Promise<DirectoryEntry[]> {
  try {
    const doc = await client.directory({ limit: 500 });
    return doc.entries;
  } catch {
    return [];
  }
}

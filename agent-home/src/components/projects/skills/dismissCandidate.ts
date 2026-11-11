import { sendJson } from "@/lib/admin-fetch";

import { dropCandidate } from "./store";

export function candidateDismissUrl(slug: string, id: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/skills/candidates/${encodeURIComponent(id)}/dismiss`;
}

/** Hide a retro-suggested skill (`dismissed_at`); the tab badge follows. */
export async function dismissCandidate(slug: string, id: string): Promise<void> {
  await sendJson(candidateDismissUrl(slug, id), "POST", {});
  dropCandidate(slug, id);
}

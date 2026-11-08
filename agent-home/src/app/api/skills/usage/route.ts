/** GET /api/skills/usage — per-skill uses and results for one profile's skills list (owner/admin). */
import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";

import { toUsageList, usageDays } from "./shape";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const days = usageDays(new URL(request.url).searchParams.get("days"));
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillUsage(days), toUsageList);
}

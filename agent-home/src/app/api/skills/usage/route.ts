/** GET /api/skills/usage — per-skill uses and results for one profile's skills list (Skills permissions). */
import { upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

import { toUsageList, usageDays } from "./shape";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("lab", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const days = usageDays(new URL(request.url).searchParams.get("days"));
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillUsage(days), toUsageList);
}

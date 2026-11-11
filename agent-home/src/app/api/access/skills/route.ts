/**
 * /api/access/skills — GET what each role may do with skills in the session's
 * profile (Settings → Skills permissions). Owner and admin only (Python
 * re-checks; it is the authority).
 */
import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest();
  return upstream(() => client.skillPermissions());
}

/**
 * POST /api/software-upgrade/check — "check now": ask GitHub for releases.
 * Read-only (it refreshes the server's cached list), so admins may use it too.
 */
import { NextResponse } from "next/server";

import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function POST(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest();
  return upstream(
    () => client.checkSoftwareUpgrade(),
    (data) => ({ ...data, can_upgrade: principal.role === "owner" }),
  );
}

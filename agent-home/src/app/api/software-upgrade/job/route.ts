/**
 * GET /api/software-upgrade/job — the progress page's poll (status without the
 * release list). Owner and admin. During the service restart this fails for
 * about a minute; the page keeps polling and reconnects by itself.
 */
import { NextResponse } from "next/server";

import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest();
  return upstream(
    () => client.softwareUpgradeJob(),
    (data) => ({ ...data, can_upgrade: principal.role === "owner" }),
  );
}

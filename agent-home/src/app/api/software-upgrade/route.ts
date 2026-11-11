/**
 * GET /api/software-upgrade — Settings → Software upgrade: what is installed,
 * the releases to pick from, the running/last job and the history. Owner and
 * admin (both may upgrade and roll back); members and viewers get 403 here
 * and in the Python API.
 */
import { NextResponse } from "next/server";

import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister, canUpgradeSoftware } from "@/lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest();
  return upstream(
    () => client.softwareUpgrade(),
    (data) => ({ ...data, can_upgrade: canUpgradeSoftware(principal) }),
  );
}

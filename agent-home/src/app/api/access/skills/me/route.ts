/**
 * /api/access/skills/me — GET what the signed-in caller may do with skills in
 * the session's profile (or `?profile=`). Drives the Skills app's visibility,
 * Skills Lab tabs and edit controls.
 */
import { NextResponse } from "next/server";

import { upstream } from "@/lib/api/admin-route";
import { getPrincipal } from "@/lib/auth/principal";
import { navRoleOf } from "@/lib/nav/menu-access";
import { profileFromUrl } from "@/lib/chat/profile";
import { getSkillPermissions } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return upstream(async () => ({
    role: navRoleOf(principal),
    actions: await getSkillPermissions(principal, profileFromUrl(request.url)),
  }));
}

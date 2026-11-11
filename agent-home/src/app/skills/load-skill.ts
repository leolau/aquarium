import "server-only";

import { notFound, redirect } from "next/navigation";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { SkillPermissions } from "@/lib/skills/permissions";
import { getSkillPermissionsOrNone } from "@/lib/skills/permissions-server";
import type { SkillDetails, SkillInfo } from "@/types";

export interface LoadedSkill {
  name: string;
  profile: string;
  content: string;
  skill: SkillInfo | null;
  skills: SkillInfo[];
  details: SkillDetails | null;
  /** What the caller may do with skills in this profile. */
  permissions: SkillPermissions;
}

/**
 * Shared loader for `/skills/[name]` and its editor. Needs the `view` Skills
 * permission (the editor passes `need: "manage"`); the BFF and Python
 * re-check. A missing skill or profile is a 404.
 */
export async function loadSkill(
  rawName: string,
  requested: string | undefined,
  withDetails: boolean,
  need: "view" | "manage" = "view",
): Promise<LoadedSkill> {
  const principal = await requirePrincipal();
  const name = decodeURIComponent(rawName);
  const profile = requested?.trim() || "default";
  const permissions = await getSkillPermissionsOrNone(principal, profile === "default" ? undefined : profile);
  if (!permissions.view || !permissions[need]) redirect("/not-available?app=skills");
  const client = await apiClientForRequest({ profile: profile === "default" ? undefined : profile });
  const [content, list, details] = await Promise.allSettled([
    client.skillContent(name),
    client.skillList(),
    // Files and "used by" need `manage` (Python gates /api/skills/details on it).
    withDetails && permissions.manage ? client.skillDetails(name) : Promise.resolve(null),
  ]);
  if (content.status === "rejected") {
    const err = content.reason;
    if (err instanceof HermesApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const skills = list.status === "fulfilled" ? list.value : [];
  return {
    name,
    profile,
    content: content.value.content ?? "",
    skill: skills.find((s) => s.name === name) ?? null,
    skills,
    details: details.status === "fulfilled" ? details.value : null,
    permissions,
  };
}

import "server-only";

import { notFound, redirect } from "next/navigation";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { SkillDetails, SkillInfo } from "@/types";

export interface LoadedSkill {
  name: string;
  profile: string;
  content: string;
  skill: SkillInfo | null;
  skills: SkillInfo[];
  details: SkillDetails | null;
}

/**
 * Shared loader for `/skills/[name]` and its editor. Owner/admin only (menu,
 * middleware, this check, then Python's `_ADMIN` gate). A missing skill or
 * profile is a 404.
 */
export async function loadSkill(rawName: string, requested: string | undefined, withDetails: boolean): Promise<LoadedSkill> {
  const principal = await requirePrincipal();
  if (!canAdminister(principal)) redirect("/not-available?app=skills");
  const name = decodeURIComponent(rawName);
  const profile = requested?.trim() || "default";
  const client = await apiClientForRequest({ profile: profile === "default" ? undefined : profile });
  const [content, list, details] = await Promise.allSettled([
    client.skillContent(name),
    client.skillList(),
    withDetails ? client.skillDetails(name) : Promise.resolve(null),
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
  };
}

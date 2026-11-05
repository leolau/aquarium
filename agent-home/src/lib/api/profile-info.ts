import type { ProfileInfo } from "@/types";

/**
 * One upstream `_profile_to_dict` row as the browser may see it: the fields
 * the Profiles page shows, never the profile's filesystem path.
 */
export function toProfileInfo(raw: Record<string, unknown>): ProfileInfo {
  return {
    name: String(raw.name ?? ""),
    is_default: raw.is_default === true,
    description: typeof raw.description === "string" ? raw.description : "",
    description_auto: raw.description_auto === true,
    model: typeof raw.model === "string" ? raw.model : null,
    provider: typeof raw.provider === "string" ? raw.provider : null,
    has_env: raw.has_env === true,
    skill_count: typeof raw.skill_count === "number" ? raw.skill_count : 0,
    gateway_running: raw.gateway_running === true,
  };
}

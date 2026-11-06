import { headers } from "next/headers";

import type { HermesApiClient } from "@/lib/api/client";
import type { ProjectViewMode, ViewDevice } from "@/types";

import { deviceFromHeaders, isProjectViewMode, resolveViewMode } from "./viewMode";

export interface ViewContext {
  device: ViewDevice;
  mode: ProjectViewMode;
}

/**
 * The device class and the person's Projects view for it, read on the
 * server so the page renders in its final mode. A `?view=` in the URL wins
 * (links that must land in a given mode); a failed preferences read falls
 * back to the device default.
 */
export async function projectViewContext(
  client: HermesApiClient,
  override?: string | string[],
): Promise<ViewContext> {
  const h = await headers();
  const device = deviceFromHeaders(h.get("user-agent"), h.get("sec-ch-ua-mobile"));
  const forced = Array.isArray(override) ? override[0] : override;
  if (isProjectViewMode(forced)) return { device, mode: forced };
  const prefs = await client.myPreferences().catch(() => null);
  return { device, mode: resolveViewMode(prefs?.project_view_mode, device) };
}

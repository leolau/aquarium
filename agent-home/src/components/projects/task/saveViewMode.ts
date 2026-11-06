import type { ProjectViewMode, ViewDevice } from "@/types";

/**
 * Remember the choice for this person and device class. Fire and forget: the
 * view already flipped, and a failed save only means the default next time.
 */
export function saveViewMode(device: ViewDevice, mode: ProjectViewMode, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl("/api/me/project-view-mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device, mode }),
  }).catch(() => undefined);
}

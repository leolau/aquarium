import type { ProjectViewMode, ViewDevice } from "@/types";

type Saver = (device: ViewDevice, mode: ProjectViewMode) => Promise<void>;

/**
 * One PUT in flight per device; taps made meanwhile collapse into a single
 * follow-up save of the latest choice. Rapid toggling therefore can't stack
 * requests or let an older response land last and store a stale mode.
 */
export function createViewModeSaver(fetchImpl: typeof fetch = fetch): Saver {
  const inFlight = new Map<ViewDevice, Promise<void>>();
  const queued = new Map<ViewDevice, ProjectViewMode>();

  const put = (device: ViewDevice, mode: ProjectViewMode) =>
    fetchImpl("/api/me/project-view-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device, mode }),
    }).then(
      () => undefined,
      () => undefined,
    );

  const drain = async (device: ViewDevice, mode: ProjectViewMode): Promise<void> => {
    let next: ProjectViewMode | undefined = mode;
    while (next !== undefined) {
      queued.delete(device);
      await put(device, next);
      next = queued.get(device);
    }
    inFlight.delete(device);
  };

  return (device, mode) => {
    const running = inFlight.get(device);
    if (running) {
      queued.set(device, mode);
      return running;
    }
    const job = drain(device, mode);
    inFlight.set(device, job);
    return job;
  };
}

const defaultSaver = createViewModeSaver();

/**
 * Remember the choice for this person and device class. The view already
 * flipped, so callers needn't wait; a failed save only means the default next time.
 */
export function saveViewMode(
  device: ViewDevice,
  mode: ProjectViewMode,
  fetchImpl?: typeof fetch,
): Promise<void> {
  return fetchImpl ? createViewModeSaver(fetchImpl)(device, mode) : defaultSaver(device, mode);
}

/**
 * Phone-shake detection from `devicemotion`. A shake is several sharp changes
 * in acceleration close together, so walking or tilting the phone doesn't count.
 */
export interface MotionSample {
  x: number;
  y: number;
  z: number;
  /** Milliseconds. */
  t: number;
}

export interface ShakeOptions {
  /** Summed per-axis change (m/s²) between samples that counts as a jolt. */
  threshold?: number;
  /** Jolts needed inside `windowMs`. */
  jolts?: number;
  windowMs?: number;
}

export const SHAKE_THRESHOLD = 22;
export const SHAKE_JOLTS = 3;
export const SHAKE_WINDOW_MS = 1000;

/** Returns a feed function that answers true on the sample completing a shake. */
export function createShakeDetector({
  threshold = SHAKE_THRESHOLD,
  jolts = SHAKE_JOLTS,
  windowMs = SHAKE_WINDOW_MS,
}: ShakeOptions = {}): (s: MotionSample) => boolean {
  let last: MotionSample | null = null;
  let times: number[] = [];
  return (s) => {
    const prev = last;
    last = s;
    if (!prev) return false;
    const delta =
      Math.abs(s.x - prev.x) + Math.abs(s.y - prev.y) + Math.abs(s.z - prev.z);
    if (delta < threshold) return false;
    times = times.filter((t) => s.t - t <= windowMs);
    times.push(s.t);
    if (times.length < jolts) return false;
    times = [];
    return true;
  };
}

type PermissionFn = () => Promise<"granted" | "denied" | "default">;

/** "needs-permission" on iOS Safari, which only allows motion after a tap. */
export type MotionSupport = "none" | "needs-permission" | "ready";

export function motionSupport(): MotionSupport {
  if (
    typeof window === "undefined" ||
    typeof window.DeviceMotionEvent === "undefined"
  )
    return "none";
  const request = (
    window.DeviceMotionEvent as unknown as { requestPermission?: PermissionFn }
  ).requestPermission;
  return typeof request === "function" ? "needs-permission" : "ready";
}

/** Asks for motion access (iOS); true when shakes can now be detected. */
export async function requestMotion(): Promise<boolean> {
  const request = (
    window.DeviceMotionEvent as unknown as { requestPermission?: PermissionFn }
  ).requestPermission;
  if (typeof request !== "function") return motionSupport() === "ready";
  try {
    return (await request()) === "granted";
  } catch {
    return false;
  }
}

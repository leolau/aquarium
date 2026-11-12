import { replaceLocation } from "@/lib/replace-location";

let leaving: Promise<void> | null = null;

/**
 * A background read answered 401: the session cookie outlived the API token
 * bridged into it. Clear the cookie first (`/login` sends a live cookie
 * straight back to `/`), then load `/login` once, however many polls hit it.
 */
export function leaveExpiredSession(): Promise<void> {
  leaving ??= fetch("/api/session/logout", { method: "POST" })
    .catch(() => undefined)
    .then(() => replaceLocation("/login"));
  return leaving;
}

/** True, and on its way to `/login`, when `res` says the session is signed out. */
export function signedOut(res: Response): boolean {
  if (res.status !== 401) return false;
  void leaveExpiredSession();
  return true;
}

export function resetExpiredSession(): void {
  leaving = null;
}

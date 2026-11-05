/**
 * Browser-side helpers for the owner/admin Profiles and Skills pages. Every
 * call goes to an agent-home BFF route (`/api/...`), never to Python.
 */
export class AdminFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminFetchError";
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  let parsed: (T & { detail?: string; error?: string }) | null = null;
  try {
    parsed = (await res.json()) as T & { detail?: string; error?: string };
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new AdminFetchError(
      res.status,
      parsed?.detail ?? parsed?.error ?? "That didn't go through.",
    );
  }
  return parsed as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: "no-store" }));
}

export async function sendJson<T>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return parse<T>(res);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "That didn't go through.";
}

/** BFF path for one profile's sub-resource. */
export function profilePath(name: string, sub = ""): string {
  return `/api/profiles/named/${encodeURIComponent(name)}${sub ? `/${sub}` : ""}`;
}

/** `?profile=` for skill calls; the default profile needs none. */
export function profileQuery(profile: string): string {
  return profile && profile !== "default" ? `profile=${encodeURIComponent(profile)}` : "";
}

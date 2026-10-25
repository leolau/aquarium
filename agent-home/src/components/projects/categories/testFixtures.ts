import { vi } from "vitest";

import type { ProjectCategory } from "@/types";

export function category(
  id: string,
  name: string,
  position: number,
  extra: Partial<ProjectCategory> = {},
): ProjectCategory {
  return {
    id,
    name,
    color: null,
    position,
    created_at: 1_700_000_000 + position,
    created_by: null,
    project_count: 0,
    ...extra,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  cache?: RequestCache;
}

/**
 * A fetch that answers GET `/api/project-categories` with `list()` and every
 * write with `write(call)` (default `{}`); records every call in order.
 */
export function categoriesFetch(opts: {
  list: () => ProjectCategory[];
  write?: (call: RecordedCall) => Response | Promise<Response>;
  read?: (url: string) => unknown;
}) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: String(input),
      method: (init.method ?? "GET").toUpperCase(),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
      cache: init.cache,
    };
    calls.push(call);
    if (call.method === "GET") {
      if (call.url === "/api/project-categories") return jsonResponse(200, { items: opts.list() });
      return jsonResponse(200, opts.read?.(call.url) ?? {});
    }
    return opts.write ? opts.write(call) : jsonResponse(200, {});
  });
  return { fetchMock, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

/**
 * API sweeps for `[smoke]` data, run in afterAll/finally so a failed spec
 * never leaves its throwaway rows behind. They go through the same BFF
 * routes the UI uses, under the signed-in test account's session.
 */
import type { APIRequestContext } from "@playwright/test";

import { SMOKE_PREFIX } from "./env";

const isSmoke = (s: unknown) => typeof s === "string" && s.trimStart().startsWith(SMOKE_PREFIX);

async function json<T>(req: APIRequestContext, url: string): Promise<T | null> {
  const res = await req.get(url);
  return res.ok() ? ((await res.json()) as T) : null;
}

/** Archive every live conversation whose title or first message is `[smoke]…`. */
export async function sweepChatSessions(req: APIRequestContext): Promise<number> {
  const data = await json<{ sessions: { id: string; title: string | null; preview: string | null }[] }>(
    req,
    "/api/chat/sessions?archived=exclude&limit=100",
  );
  let n = 0;
  for (const s of data?.sessions ?? []) {
    // The composer prefixes an `[app context: …]` line, so the typed
    // `[smoke] …` text is inside the preview, not at its start.
    if (!isSmoke(s.title) && !(s.preview ?? "").includes(SMOKE_PREFIX)) continue;
    const res = await req.patch("/api/chat/sessions/archive", {
      data: { sessionId: s.id, archived: true },
    });
    if (res.ok()) n += 1;
  }
  return n;
}

/** Dismiss (the UI's delete) every live `[smoke]` to-do. */
export async function sweepTodos(req: APIRequestContext): Promise<number> {
  let n = 0;
  for (const stage of ["staged", "open", "working"]) {
    const data = await json<{ items: { id: string; title: string }[] }>(
      req,
      `/api/todos?q=${encodeURIComponent(SMOKE_PREFIX)}&stage=${stage}&include_snoozed=true&limit=100`,
    );
    for (const t of data?.items ?? []) {
      if (!isSmoke(t.title)) continue;
      const res = await req.post(`/api/todos/${encodeURIComponent(t.id)}/stage`, {
        data: { stage: "dismissed" },
      });
      if (res.ok()) n += 1;
    }
  }
  return n;
}

/** Archive, stopping an open run first (the server refuses to archive with one). */
async function archiveProject(req: APIRequestContext, slug: string): Promise<void> {
  const context = await json<{ open_run: { run_no: number } | null }>(req, `/api/projects/${slug}/board/context`);
  if (context?.open_run) {
    await req.post(`/api/projects/${slug}/runs/${context.open_run.run_no}/stop`, { data: {} });
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await req.post(`/api/projects/${slug}/archive`, { data: { reason: "e2e cleanup" } });
    if (res.ok() || res.status() !== 409) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Permanently remove an archived `[smoke]` project together with its runs,
 * cards and run sessions (`?purge=smoke`). The server only allows this for
 * an archived `[smoke]` project the caller created with no open run; a run
 * that was just stopped can take a few seconds to close, so a 409 is
 * retried. Falls back to the plain delete (a never-run project someone else
 * created). Answers whether the project is gone.
 */
export async function purgeSmokeProject(req: APIRequestContext, slug: string): Promise<boolean> {
  const path = `/api/projects/${encodeURIComponent(slug)}?confirm=${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await req.delete(`${path}&purge=smoke`);
    if (res.ok() || res.status() === 404) return true;
    if (res.status() !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return (await req.delete(path)).ok();
}

/** Archive every `[smoke]` project, then purge it (see `purgeSmokeProject`). */
export async function sweepProjects(req: APIRequestContext): Promise<number> {
  let n = 0;
  for (const archived of [false, true]) {
    const data = await json<{ items: { slug: string; name?: string; goal?: string }[] }>(
      req,
      `/api/projects?archived=${archived}&q=${encodeURIComponent(SMOKE_PREFIX)}&limit=100`,
    );
    for (const p of data?.items ?? []) {
      if (!isSmoke(p.name) && !isSmoke(p.goal)) continue;
      if (!archived) await archiveProject(req, encodeURIComponent(p.slug));
      if (await purgeSmokeProject(req, p.slug)) n += 1;
    }
  }
  return n;
}

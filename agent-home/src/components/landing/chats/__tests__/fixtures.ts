import type { LandingSession } from "../model";

export const NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
const min = (m: number) => NOW / 1000 - m * 60;

function session(id: string, over: Partial<LandingSession>): LandingSession {
  return {
    id,
    source: "web",
    model: null,
    title: null,
    started_at: min(600),
    ended_at: null,
    message_count: 6,
    preview: "",
    last_active: min(600),
    is_active: false,
    pinned_at: null,
    ...over,
  } as LandingSession;
}

export const sessions: LandingSession[] = [
  session("s-refactor", { title: "Refactor billing webhooks", last_active: min(14), pinned_at: min(30) }),
  session("s-q3", { title: "Q3 planning notes", last_active: min(60 * 26), pinned_at: min(90) }),
  session("s-pricing", { title: "Pricing page copy review", last_active: min(1), is_active: true }),
  session("s-untitled", { preview: "can you check why the nightly sync failed", last_active: min(5) }),
  session("s-flaky", { title: "Debug flaky e2e test", last_active: min(180) }),
  session("s-onboarding", { title: "Onboarding email sequence", last_active: min(60 * 30) }),
  session("s-old", { title: "Archived thing", last_active: min(2), archived: true }),
];

/** `sessions` as the landing page lists them: chats typed in Aquarium (`agent_home`). */
export const userChatSessions: LandingSession[] = sessions.map((s) => ({
  ...s,
  source: "agent_home",
  preview: s.preview || s.title,
}));

type Handler = (init: RequestInit | undefined, url: URL) => Response | Promise<Response>;

/** A `fetch` stub routing by "METHOD /path"; unmatched routes are 404. */
export function fakeFetch(routes: Record<string, Handler>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return handler(init, url);
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The list as served before the pins workstream ships: no `pinned_at` key. */
export function withoutPins(list: LandingSession[]): LandingSession[] {
  return list.map((s) => {
    const copy = { ...s };
    delete copy.pinned_at;
    return copy;
  });
}

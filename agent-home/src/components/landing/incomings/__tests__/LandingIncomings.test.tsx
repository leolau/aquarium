// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (cb: () => void) => {
    window.addEventListener("popstate", cb);
    window.addEventListener("test:navigate", cb);
    return () => {
      window.removeEventListener("popstate", cb);
      window.removeEventListener("test:navigate", cb);
    };
  };
  return {
    useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    usePathname: () => "/",
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  };
});
vi.mock("@/lib/chat/session-list-fetch", () => ({
  fetchSessionList: async (url: string) => {
    const res = await fetch(url);
    return res.ok ? res.json() : null;
  },
}));
vi.mock("@/components/ui/useStatusSummary", () => ({ useStatusSummary: () => ({}) }));
vi.mock("@/components/ui/useActivityRunning", () => ({ useActivityRunning: () => ({}) }));
vi.mock("@/lib/landing/needsYou", () => ({
  useNeedsYou: () => ({
    items: [],
    count: 0,
    newIds: [],
    loading: false,
    stale: false,
    refresh: () => {},
    markSeen: () => {},
    bySeverity: { blocking: 0 },
  }),
}));
vi.mock("../../topbar", () => ({ TopBarView: () => <div data-component="TopBar" /> }));
vi.mock("../../work", () => ({ LandingWorkPanel: () => <div data-component="LandingWorkPanel" /> }));
vi.mock("@/components/projects/AddToProjectSheet", () => ({
  AddToProjectSheet: ({ prefill }: { prefill: { ref: string } }) => (
    <div data-component="AddToProjectSheet" data-ref={prefill.ref} />
  ),
}));

import { fakeFetch, json, userChatSessions as sessions } from "../../chats/__tests__/fixtures";
import { LandingClient } from "../../LandingClient";
import { flagged } from "./fixtures";
import type { IncomingItem } from "@/types";

type Routes = Parameters<typeof fakeFetch>[0];

let open: IncomingItem[];
const writes: { url: string; body: unknown }[] = [];

function install(over: Routes = {}) {
  open = [...flagged];
  writes.length = 0;
  const f = vi.fn(
    fakeFetch({
      "GET /api/chat/sessions": () => json({ sessions }),
      "GET /api/incomings": () => json({ items: open, next_cursor: null }),
      "GET /api/incomings/attention-count": () =>
        json({ count: open.length, urgent: 2, by_surface: { email: 2, whatsapp: 1, calendar: 1 } }),
      "GET /api/incomings/facets": () => json({ surfaces: [{ value: "email", count: 3 }] }),
      ...Object.fromEntries(
        flagged.map((i) => [
          `GET /api/incomings/${i.id}`,
          () => json({ ...i, attachments: [] }),
        ]),
      ),
      ...Object.fromEntries(
        flagged.map((i) => [
          `POST /api/incomings/${i.id}/attention`,
          (init: RequestInit | undefined, url: URL) => {
            const body = JSON.parse(String(init?.body));
            writes.push({ url: url.pathname, body });
            if (body.action === "clear") open = open.filter((o) => o.id !== i.id);
            else open = [...open, i];
            return json({ ...i, attention_cleared_at: body.action === "clear" ? "now" : null });
          },
        ]),
      ),
      "POST /api/todos": (init, url) => {
        writes.push({ url: url.pathname, body: JSON.parse(String(init?.body)) });
        return json({ id: "td-1", ref: "T42" });
      },
      ...over,
    }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

const realPush = window.history.pushState.bind(window.history);
let desktop = true;

function renderLanding() {
  return render(<LandingClient profiles={[{ name: "default", is_default: true }] as never} currentProfile="default" />);
}

const sidebar = () => within(document.querySelector<HTMLElement>('[data-component="landing-sidebar"]')!);
const incomingsTab = () => sidebar().getByRole("tab", { name: /^Incomings/ });
const panel = () => within(document.querySelector<HTMLElement>('[data-component="IncomingsPanel"]')!);

async function openIncomingsTab() {
  renderLanding();
  fireEvent.click(incomingsTab());
  await panel().findByText("Grace Hopper");
}

beforeEach(() => {
  push.mockReset();
  install();
  window.localStorage.clear();
  realPush(null, "", "/");
  window.history.pushState = (...args: Parameters<History["pushState"]>) => {
    realPush(...args);
    window.dispatchEvent(new Event("test:navigate"));
  };
  desktop = true;
  window.matchMedia = ((q: string) => ({ matches: q.includes("min-width") ? desktop : false })) as never;
});
afterEach(() => {
  cleanup();
  window.history.pushState = realPush;
  vi.unstubAllGlobals();
});

describe("LeftPanelTabs", () => {
  it("starts on Chats, badges the waiting count, and remembers the Incomings choice", async () => {
    renderLanding();
    const chats = sidebar().getByRole("tab", { name: "Chats" });
    expect(chats.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(incomingsTab().textContent).toContain("4"));
    expect(within(incomingsTab()).getByLabelText("4 need you")).toBeTruthy();

    fireEvent.click(incomingsTab());
    expect(incomingsTab().getAttribute("aria-selected")).toBe("true");
    expect(window.localStorage.getItem("aquarium.landing.leftTab")).toBe("incomings");
    expect(await panel().findByText("Grace Hopper")).toBeTruthy();

    cleanup();
    renderLanding();
    expect(incomingsTab().getAttribute("aria-selected")).toBe("true");
  });

  it("switches with the arrow keys", () => {
    renderLanding();
    fireEvent.keyDown(sidebar().getByRole("tablist"), { key: "ArrowRight" });
    expect(incomingsTab().getAttribute("aria-selected")).toBe("true");
  });

  it("/?panel=incomings selects the tab", async () => {
    realPush(null, "", "/?panel=incomings");
    renderLanding();
    await waitFor(() => expect(incomingsTab().getAttribute("aria-selected")).toBe("true"));
  });

  it("shows the count on the collapsed rail", async () => {
    renderLanding();
    await waitFor(() => expect(incomingsTab().textContent).toContain("4"));
    fireEvent.click(screen.getByRole("button", { name: "Collapse chats panel" }));
    const rail = screen.getByRole("button", { name: /Expand chats panel, 4 incomings waiting/ });
    expect(rail.textContent).toContain("Chats & incomings");
    expect(rail.querySelector('[data-slot="rail-badge"]')?.textContent).toBe("4");
  });
});

describe("IncomingsPanel", () => {
  it("asks for open attention items and groups them Urgent / Needs a look with reason lines", async () => {
    await openIncomingsTab();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/incomings\?attention=open/),
      expect.anything(),
    );
    const urgent = within(panel().getByRole("region", { name: "Urgent" }));
    const look = within(panel().getByRole("region", { name: "Needs a look" }));
    expect(urgent.getByText("Grace Hopper")).toBeTruthy();
    expect(urgent.getByText("Board review")).toBeTruthy();
    expect(urgent.getByText("Escalated by triage · urgent priority")).toBeTruthy();
    expect(urgent.getByText("Critical calendar event")).toBeTruthy();
    expect(look.getByText("Ada Lovelace")).toBeTruthy();
    expect(look.getByText("Triage made 2 to-dos from this")).toBeTruthy();
    expect(panel().getByRole("link", { name: /Open Inbox/ }).getAttribute("href")).toBe("/inbox");
  });

  it("filters by channel with counted chips", async () => {
    await openIncomingsTab();
    const chip = (name: RegExp) => panel().getByRole("button", { name });
    expect(chip(/^All 4/).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^Messages 1/)).toBeTruthy();
    expect(chip(/^Calendar 1/)).toBeTruthy();
    fireEvent.click(chip(/^Email 2/));
    expect(panel().queryByText("Grace Hopper")).toBeNull();
    expect(panel().getByText("Ada Lovelace")).toBeTruthy();
    expect(panel().getByText("Linus")).toBeTruthy();
  });

  it("is all clear when nothing waits, and explains a profile with no triage source", async () => {
    install({
      "GET /api/incomings": () => json({ items: [], next_cursor: null }),
    });
    renderLanding();
    fireEvent.click(incomingsTab());
    expect(await panel().findByText("All clear")).toBeTruthy();

    cleanup();
    install({
      "GET /api/incomings": () => json({ items: [], next_cursor: null }),
      "GET /api/incomings/facets": () => json({ surfaces: [] }),
    });
    renderLanding();
    expect(await panel().findByText("Nothing arrives in this profile yet")).toBeTruthy();
  });

  it("never lists an arrival that is not flagged or already cleared", async () => {
    install({
      "GET /api/incomings": () =>
        json({
          items: [
            flagged[0],
            { ...flagged[2], attention_at: null },
            { ...flagged[3], attention_cleared_at: "2026-11-11T05:00:00Z" },
          ],
        }),
    });
    await openIncomingsTab();
    expect(panel().queryByText("Ada Lovelace")).toBeNull();
    expect(panel().queryByText("Linus")).toBeNull();
  });

  it("shows an error with a retry that reloads", async () => {
    let fail = true;
    install({
      "GET /api/incomings": () =>
        fail ? json({ error: "api_unreachable" }, 502) : json({ items: flagged }),
    });
    renderLanding();
    fireEvent.click(incomingsTab());
    expect(await panel().findByText(/Incomings couldn't be loaded/)).toBeTruthy();
    fail = false;
    fireEvent.click(panel().getByRole("button", { name: "Try again" }));
    expect(await panel().findByText("Grace Hopper")).toBeTruthy();
  });
});

describe("Done + Undo", () => {
  it("clears a row at once, writes clear/done, and Undo reopens it", async () => {
    await openIncomingsTab();
    fireEvent.click(panel().getByRole("button", { name: "Mark “Q4 budget sign-off” done" }));
    expect(panel().queryByText("Ada Lovelace")).toBeNull();
    await waitFor(() =>
      expect(writes).toContainEqual({
        url: "/api/incomings/in-mail/attention",
        body: { action: "clear", outcome: "done" },
      }),
    );
    const toast = await screen.findByText(/Marked done\. Ada Lovelace moved out of Incomings/);
    fireEvent.click(within(toast.parentElement!).getByRole("button", { name: /Undo/ }));
    await waitFor(() =>
      expect(writes).toContainEqual({ url: "/api/incomings/in-mail/attention", body: { action: "reopen" } }),
    );
    expect(await panel().findByText("Ada Lovelace")).toBeTruthy();
  });

  it("puts the row back and shows an owner-only error toast on a 403", async () => {
    install({
      "POST /api/incomings/in-mail/attention": () => json({ error: "api_error" }, 403),
    });
    await openIncomingsTab();
    fireEvent.click(panel().getByRole("button", { name: "Mark “Q4 budget sign-off” done" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Only the person this arrived for can mark it done or reopen it.",
    );
    expect(panel().getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByText(/Marked done/)).toBeNull();
  });
});

describe("centre-column detail", () => {
  it("opens a row in place with the reason and the actions", async () => {
    await openIncomingsTab();
    fireEvent.click(panel().getByRole("link", { name: "Ada Lovelace" }));
    expect(window.location.search).toBe("?incoming=in-mail");
    expect(push).not.toHaveBeenCalled();
    const view = within(document.querySelector<HTMLElement>('[data-component="LandingIncomingView"]')!);
    expect(view.getByRole("heading", { name: "Q4 budget sign-off" })).toBeTruthy();
    expect(view.getByText("Escalated by triage · medium priority")).toBeTruthy();
    expect(await view.findByText("Please approve the attached budget.")).toBeTruthy();

    const reply = view.getByRole("link", { name: /Reply with AI/ }).getAttribute("href")!;
    expect(reply).toMatch(/^\/chat\?new=1&autosend=1&draft=/);
    expect(new URLSearchParams(reply.split("?")[1]).get("draft")).toContain("Q4 budget sign-off");
    expect(view.getByRole("link", { name: /Open in Inbox/ }).getAttribute("href")).toBe("/inbox/in-mail");

    fireEvent.click(view.getByRole("button", { name: "Make a to-do" }));
    expect(await view.findByText("To-do made from T42.")).toBeTruthy();
    expect(writes).toContainEqual({
      url: "/api/todos",
      body: expect.objectContaining({ title: "Q4 budget sign-off", source_kind: "inbound", source_ref: "in-mail" }),
    });

    fireEvent.click(view.getByRole("button", { name: "Add to project" }));
    expect(document.querySelector('[data-component="AddToProjectSheet"]')?.getAttribute("data-ref")).toBe("in-mail");
  });

  it("Done in the detail clears it, returns to the composer and offers Undo", async () => {
    await openIncomingsTab();
    fireEvent.click(panel().getByRole("link", { name: "Ada Lovelace" }));
    const view = within(document.querySelector<HTMLElement>('[data-component="LandingIncomingView"]')!);
    fireEvent.click(view.getByRole("button", { name: /Done/ }));
    expect(window.location.search).toBe("");
    expect(document.querySelector('[data-component="LandingComposer"]')).toBeTruthy();
    expect(await screen.findByText(/Marked done/)).toBeTruthy();
  });
});

describe("phone drawer", () => {
  it("has the same switch, titles itself after the tab, and rows open /inbox/{id}?from=landing", async () => {
    desktop = false;
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: /^Chats/ }));
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByRole("heading", { name: "Chats" })).toBeTruthy();
    fireEvent.click(drawer.getByRole("tab", { name: /^Incomings/ }));
    expect(drawer.getByRole("heading", { name: "Incomings" })).toBeTruthy();
    const row = await drawer.findByRole("link", { name: "Grace Hopper" });
    expect(row.getAttribute("href")).toBe("/inbox/in-wa?from=landing");
    fireEvent.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("/?panel=incomings opens the drawer on the Incomings tab on a phone", async () => {
    desktop = false;
    realPush(null, "", "/?panel=incomings");
    renderLanding();
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByRole("heading", { name: "Incomings" })).toBeTruthy();
  });
});

describe("attention count", () => {
  it("keeps the last good count when a read fails", async () => {
    let fail = false;
    install({
      "GET /api/incomings/attention-count": () =>
        fail ? json({ error: "api_unreachable" }, 502) : json({ count: 3, urgent: 0, by_surface: {} }),
    });
    renderLanding();
    await waitFor(() => expect(incomingsTab().textContent).toContain("3"));
    fail = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(incomingsTab().textContent).toContain("3");
  });
});

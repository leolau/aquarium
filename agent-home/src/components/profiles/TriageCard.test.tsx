// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TriageCard } from "@/components/profiles/TriageCard";
import { DIR, kind, status } from "@/components/profiles/triage-fixtures";
import type { TriageKindStatus } from "@/types";

const fetchMock = vi.fn();
const reply = (body: unknown, s = 200) => Promise.resolve(new Response(JSON.stringify(body), { status: s }));
const FILE = `${DIR}/email-triage/escalation-rules.md`;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return reply({ ok: true, path: FILE });
    if (String(url).startsWith("/api/triage/skill-file/history")) {
      return reply({
        kind: "email",
        path: FILE,
        versions: [
          { id: "2", at: 1700000100, author: "user:dan", message: "Edited in Agent Profiles", content: "# v2" },
          { id: "1", at: 1700000000, author: "system", message: "Before the first edit", content: "# v1" },
        ],
      });
    }
    const editable = !String(url).includes("profile=member-land");
    return reply({ kind: "email", name: "escalation-rules.md", path: FILE, content: "# v2", can_edit: editable });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (c: HTMLElement) => c.querySelector('[data-component="TriageCard"]') as HTMLElement;

describe("TriageCard states", () => {
  it("set_up: lists the kinds that are on with each skill file's name and path, Edit and History", () => {
    const { container } = render(
      <TriageCard profile="hr" status={status([kind("email", "set_up"), kind("whatsapp", "set_up"), kind("calendar", "not_set_up", ["account"])])} />,
    );
    expect(card(container).dataset.state).toBe("set_up");
    expect(screen.getByText(/Triage · set up for you/)).toBeTruthy();
    const email = container.querySelector('[data-kind="email"][data-state="set_up"]') as HTMLElement;
    expect(within(email).getByText("escalation-rules.md")).toBeTruthy();
    expect(within(email).getByText(FILE)).toBeTruthy();
    expect(within(email).getByRole("button", { name: "Edit Email escalation-rules.md" })).toBeTruthy();
    expect(within(email).getByRole("button", { name: "History of Email escalation-rules.md" })).toBeTruthy();
    expect(container.querySelector('[data-kind="whatsapp"][data-state="set_up"]')).not.toBeNull();
    // A kind that isn't on lists no files, only how to set it up.
    const cal = container.querySelector('[data-kind="calendar"]') as HTMLElement;
    expect(cal.querySelector('[data-component="TriageSkillFile"]')).toBeNull();
    expect(within(cal).getByRole("link", { name: "Connect Google →" }).getAttribute("href")).toBe("/settings/in-out/google");
  });

  it("partly_set_up: says what's missing in plain words, with a link to fix it", () => {
    const { container } = render(
      <TriageCard
        profile="hr"
        status={status([kind("email", "partly_set_up", ["other_person_polled"]), kind("whatsapp", "partly_set_up", ["credential", "skills"]), kind("calendar", "not_set_up", ["account"])])}
      />,
    );
    expect(card(container).dataset.state).toBe("partly_set_up");
    expect(screen.getByText(/Triage · partly set up/)).toBeTruthy();
    expect(screen.getByText("Another person's sign-in is the one polled for your mailbox")).toBeTruthy();
    expect(screen.getByText("Your WhatsApp number has no saved sign-in")).toBeTruthy();
    expect(screen.getByText("The triage skill files are missing")).toBeTruthy();
    const fix = within(container.querySelector('[data-kind="email"]') as HTMLElement).getByRole("link", { name: /Fix it in Settings → Mailboxes/ });
    expect(fix.getAttribute("href")).toBe("/settings/in-out");
    expect(container.querySelector('[data-component="TriageSkillFile"]')).toBeNull();
  });

  it("not_set_up: reminds that triage exists, with links to set it up", () => {
    const { container } = render(
      <TriageCard profile="hr" status={status(["email", "whatsapp", "calendar"].map((k) => kind(k as TriageKindStatus["kind"], "not_set_up", ["account"])))} />,
    );
    expect(card(container).dataset.state).toBe("not_set_up");
    expect(screen.getByText(/Triage · not set up yet/)).toBeTruthy();
    expect(screen.getByText(/Aquarium can triage your incoming messages/)).toBeTruthy();
    const hrefs = [...screen.getByTestId("triage-reminder").querySelectorAll("a")].map((a) => `${a.textContent} ${a.getAttribute("href")}`);
    expect(hrefs).toEqual([
      "Mailboxes → /settings/in-out",
      "Connect Google → /settings/in-out/google",
      "WhatsApp bridges → /settings/in-out",
      "Connected accounts → /settings/in-out",
      "Connect Google → /settings/in-out/google",
    ]);
  });
});

describe("TriageCard roles", () => {
  it("owner/admin: Edit opens the file editable and Save PUTs it for this profile", async () => {
    render(<TriageCard profile="hr" status={status([kind("email", "set_up")], true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Email escalation-rules.md" }));
    const box = (await screen.findByDisplayValue("# v2")) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(false);
    expect(screen.queryByTestId("triage-read-only")).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/triage/skill-file?kind=email&path=${encodeURIComponent(FILE)}&profile=hr`);
    fireEvent.change(box, { target: { value: "# v3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved as a new version/);
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(put[0]).toBe("/api/triage/skill-file?profile=hr");
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ kind: "email", path: FILE, content: "# v3" });
  });

  it.each(["member", "viewer"])("%s: View only, read-only editor, no Save and no write", async () => {
    render(<TriageCard profile="hr" status={status([kind("email", "set_up")], false)} />);
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View Email escalation-rules.md" }));
    const box = (await screen.findByDisplayValue("# v2")) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(screen.getByTestId("triage-read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/Only an owner or admin can change the triage skills/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("stays read-only when Hermes says the caller can't edit in this profile", async () => {
    render(<TriageCard profile="member-land" status={status([kind("email", "set_up")], true, "member-land")} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Email escalation-rules.md" }));
    const box = (await screen.findByDisplayValue("# v2")) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("History lists the saved versions for anyone, newest first", async () => {
    render(<TriageCard profile="hr" status={status([kind("email", "set_up")], false)} />);
    fireEvent.click(screen.getByRole("button", { name: "History of Email escalation-rules.md" }));
    expect((await screen.findByTestId("triage-version-content")).textContent).toBe("# v2");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/triage/skill-file/history?kind=email&path=${encodeURIComponent(FILE)}&profile=hr`)).toBe(true);
    fireEvent.click(screen.getByText(/As installed/));
    await waitFor(() => expect(screen.getByTestId("triage-version-content").textContent).toBe("# v1"));
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillImprovePanel } from "@/components/skills/SkillImprovePanel";
import { extractDraft, stripDraft } from "@/lib/skills/improve";

const LIVE = "---\nname: quotation-builder\n---\n\n# Quotes\n\nAlways quote in HKD.\n";
const PROPOSED = "---\nname: quotation-builder\n---\n\n# Quotes\n\nQuote in the currency the client asks for.\n";

const VERSIONS = {
  name: "quotation-builder",
  active: "v4",
  versions: [
    { id: "v4", n: 4, created_at: 1790000000, author: "user:yan", message: "Tighten", parent: "v3", status: "active", source: "edit", trial_of: null },
    { id: "v3", n: 3, created_at: 1789000000, author: "user:yan", message: "Init", parent: null, status: "archived", source: "edit", trial_of: null },
  ],
};
const EVENTS = {
  name: "quotation-builder",
  events: [
    { id: 11, ts: 1790000100, trigger: "skill_view", version_id: "v4", outcome: "failure", outcome_source: "kanban", rating: null, note: null, session: null, task: { id: "t1", title: "Quote for ACME (USD)" }, project: null, user_id: "yan" },
    { id: 12, ts: 1790000200, trigger: "slash", version_id: "v4", outcome: null, outcome_source: "user", rating: -1, note: "wrong currency", session: { id: "c1", title: "Quote retail" }, task: null, project: null, user_id: "yan" },
    { id: 13, ts: 1790000300, trigger: "preload", version_id: "v3", outcome: "success", outcome_source: "kanban", rating: null, note: null, session: null, task: null, project: { slug: "q3", name: "Q3 pricing" }, user_id: "yan" },
  ],
  next_cursor: null,
};
const SESSIONS = [{ session_id: "imp-old", title: "Currency handling", started_at: 1790000400, drafts: 1 }];

type Route = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Route>;
const fetchMock = vi.fn();
const ok = (body: unknown) => () => ({ body });
const fail = (status: number, detail: string) => () => ({ status, body: { detail } });

function respond(url: string, init?: RequestInit) {
  const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
  const route = routes[key];
  if (!route) throw new Error(`unexpected ${key}`);
  const { status = 200, body } = route(init);
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}
const callsTo = (key: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(u).split("?")[0]}` === key);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  routes = {
    "GET /api/skills/versions": ok(VERSIONS),
    "GET /api/skills/usage/detail": ok(EVENTS),
    "GET /api/skills/improve/sessions": ok(SESSIONS),
    "GET /api/chat/messages": ok({ messages: [] }),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(respond);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const onOpenTab = vi.fn();
function panel(profile = "default") {
  return render(<SkillImprovePanel name="quotation-builder" profile={profile} content={LIVE} onOpenTab={onOpenTab} />);
}
const composer = () => screen.getByLabelText("Message the agent") as HTMLTextAreaElement;

describe("draft helpers", () => {
  it("takes the last skill-draft block and strips drafts from the reply", () => {
    const reply = "Idea one\n```skill-draft\nold\n```\nBetter:\n```skill-draft\n" + PROPOSED + "```\nThoughts?";
    expect(extractDraft(reply)).toBe(PROPOSED.replace(/\n$/, ""));
    expect(stripDraft(reply)).toBe("Idea one\n\nBetter:\n\nThoughts?");
    expect(extractDraft("no draft ```python\nx\n```")).toBeNull();
  });

  it("keeps code blocks nested inside a draft", () => {
    const skill = "# Tidy\n\n```bash\nqpdf --check in.pdf\n```\n\nDone.";
    for (const fence of ["```", "````"]) {
      const reply = `Fixed.\n${fence}skill-draft\n${skill}\n${fence}\nTry it.`;
      expect(extractDraft(reply)).toBe(skill);
      expect(stripDraft(reply)).toBe("Fixed.\n\nTry it.");
    }
    expect(extractDraft("```skill-draft\nunterminated")).toBeNull();
  });
});

describe("SkillImprovePanel", () => {
  it("shows loading states, then evidence, past chats and the permissions notice", async () => {
    panel();
    expect(screen.getByText("Loading runs…")).toBeTruthy();
    expect(screen.getByText("Loading chats…")).toBeTruthy();
    expect(await screen.findByText("Task · Quote for ACME (USD)")).toBeTruthy();
    expect(screen.getByText(/Based on v4 \(active\)/)).toBeTruthy();
    // Failed filter is the default; the not-helpful chat run is behind its own chip.
    expect(screen.queryByText(/Quote retail/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not helpful 1" }));
    expect(screen.getByText("Chat · “Quote retail”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All runs" }));
    expect(screen.getByText("Project · Q3 pricing")).toBeTruthy();
    expect(await screen.findByText("Currency handling")).toBeTruthy();
    expect(screen.getByText(/Improve chats run as you, with your permissions\./)).toBeTruthy();
    expect(screen.getByText(/Start an improve chat to work on this skill/)).toBeTruthy();
  });

  it("scopes every read to the selected profile", async () => {
    panel("coder");
    await screen.findByText("Currency handling");
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain("profile=coder");
  });

  it("shows empty evidence and no past chats", async () => {
    routes["GET /api/skills/usage/detail"] = ok({ name: "quotation-builder", events: [], next_cursor: null });
    routes["GET /api/skills/improve/sessions"] = ok([]);
    panel();
    expect(await screen.findByText("No recorded runs in the last 90 days.")).toBeTruthy();
    expect(await screen.findByText("No improve chats yet.")).toBeTruthy();
  });

  it("shows load errors with a working retry", async () => {
    routes["GET /api/skills/usage/detail"] = fail(500, "ledger offline");
    routes["GET /api/skills/improve/sessions"] = fail(500, "sessions offline");
    panel();
    expect(await screen.findByText(/ledger offline/)).toBeTruthy();
    expect(await screen.findByText(/sessions offline/)).toBeTruthy();
    routes["GET /api/skills/usage/detail"] = ok(EVENTS);
    const evidence = screen.getByRole("region", { name: "Evidence shared with the agent" });
    fireEvent.click(within(evidence).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Task · Quote for ACME (USD)")).toBeTruthy();
  });

  it("selecting a run adds a reference to the composer", async () => {
    panel();
    fireEvent.click(await screen.findByText("Task · Quote for ACME (USD)"));
    expect(composer().value).toBe("[run #11 · Task Quote for ACME (USD) · failed · v4] ");
    expect(document.activeElement).toBe(composer());
  });

  it("starts a new improve chat with an optional goal", async () => {
    routes["POST /api/skills/improve/start"] = ok({ session_id: "imp-new" });
    panel("coder");
    fireEvent.click(screen.getByRole("button", { name: /New improve chat/ }));
    fireEvent.change(screen.getByLabelText("Goal (optional)"), { target: { value: "fix currency" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(callsTo("GET /api/chat/messages")).toHaveLength(1));
    expect(bodyOf(callsTo("POST /api/skills/improve/start")[0])).toEqual({ name: "quotation-builder", goal: "fix currency", profile: "coder" });
    expect(String(callsTo("GET /api/chat/messages")[0][0])).toContain("sessionId=imp-new");
    expect(await screen.findByText(/Tell the agent what to change, or pick runs to discuss\./)).toBeTruthy();
  });

  it("sends a turn, shows the proposal with a diff and saves it as the next draft version", async () => {
    routes["POST /api/skills/improve/start"] = ok({ session_id: "imp-new" });
    routes["POST /api/skills/improve/message"] = ok({ reply: "Try this:\n```skill-draft\n" + PROPOSED + "```", draft: PROPOSED });
    routes["POST /api/skills/versions/draft"] = ok({ ...VERSIONS.versions[0], id: "v5", n: 5, status: "draft", source: "improve" });
    panel();
    await screen.findByText("Currency handling");
    fireEvent.change(composer(), { target: { value: "Handle USD quotes" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(await screen.findByText("Handle USD quotes")).toBeTruthy();
    const card = await screen.findByRole("region", { name: "Proposed SKILL.md" });
    expect(screen.getByText("Try this:")).toBeTruthy();
    expect(within(card).getByText("+1 −1 lines")).toBeTruthy();
    expect(card.querySelector('[data-diff="add"]')?.textContent).toContain("Quote in the currency the client asks for.");
    expect(card.querySelector('[data-diff="del"]')?.textContent).toContain("Always quote in HKD.");
    // A turn with no open chat starts one first.
    expect(bodyOf(callsTo("POST /api/skills/improve/start")[0])).toEqual({ name: "quotation-builder" });
    expect(bodyOf(callsTo("POST /api/skills/improve/message")[0])).toEqual({ session_id: "imp-new", text: "Handle USD quotes" });

    fireEvent.click(within(card).getByRole("button", { name: "View full diff" }));
    expect(within(card).getByRole("button", { name: "Show changes only" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Ask for changes" }));
    expect(document.activeElement).toBe(composer());

    fireEvent.click(within(card).getByRole("button", { name: /Save as draft v5/ }));
    expect(await within(card).findByText(/Saved as draft v5\./)).toBeTruthy();
    expect(bodyOf(callsTo("POST /api/skills/versions/draft")[0])).toEqual({
      name: "quotation-builder",
      content: PROPOSED,
      message: "Improve chat proposal",
      session_id: "imp-new",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Open in Versions" }));
    expect(onOpenTab).toHaveBeenCalledWith("versions");
  });

  it("keeps a failed turn retryable", async () => {
    let attempts = 0;
    routes["POST /api/skills/improve/start"] = ok({ session_id: "imp-new" });
    routes["POST /api/skills/improve/message"] = () => (++attempts === 1 ? { status: 502, body: { detail: "agent unavailable" } } : { body: { reply: "Done thinking." } });
    panel();
    fireEvent.change(composer(), { target: { value: "Why does it fail?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("agent unavailable")).toBeTruthy();
    expect(screen.queryByText("Why does it fail?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Done thinking.")).toBeTruthy();
    expect(screen.getByText("Why does it fail?")).toBeTruthy();
    expect(callsTo("POST /api/skills/improve/start")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Proposed SKILL.md" })).toBeNull();
  });

  it("resumes a past chat and restores its last proposal", async () => {
    routes["GET /api/chat/messages"] = ok({
      messages: [
        { id: 1, role: "user", content: "Make it handle USD" },
        { id: 2, role: "tool", content: "{}" },
        { id: 3, role: "assistant", content: "Proposal:\n```skill-draft\n" + PROPOSED + "```" },
      ],
    });
    routes["POST /api/skills/versions/draft"] = fail(409, "draft conflict");
    panel();
    fireEvent.click(await screen.findByText("Currency handling"));
    expect(await screen.findByText("Make it handle USD")).toBeTruthy();
    expect(screen.queryByText("{}")).toBeNull();
    const card = await screen.findByRole("region", { name: "Proposed SKILL.md" });
    expect(screen.getByRole("button", { name: /Currency handling/ }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(card).getByRole("button", { name: /Save as draft v5/ }));
    expect(await screen.findByText("draft conflict")).toBeTruthy();
    expect(bodyOf(callsTo("POST /api/skills/versions/draft")[0])).toMatchObject({ message: "Currency handling", session_id: "imp-old" });
  });
  it("replays a past chat without the hidden context or tool-call-only turns", async () => {
    routes["GET /api/chat/messages"] = ok({
      messages: [
        {
          id: 1,
          role: "user",
          content: 'You are helping me improve the skill "invoice-parser".\n\n=== Skill context ===\nSECRET-CONTEXT\n\n## My message\nMake it handle USD',
        },
        { id: 2, role: "assistant", content: "" },
        { id: 3, role: "tool", content: "{}" },
        { id: 4, role: "assistant", content: "   " },
        { id: 5, role: "assistant", content: "Proposal:\n```skill-draft\n" + PROPOSED + "```" },
      ],
    });
    panel();
    fireEvent.click(await screen.findByText("Currency handling"));
    expect(await screen.findByText("Make it handle USD")).toBeTruthy();
    expect(screen.queryByText(/SECRET-CONTEXT/)).toBeNull();
    expect(screen.queryAllByText("Here is a proposed SKILL.md.")).toHaveLength(0);
    expect(screen.getByText("Proposal:")).toBeTruthy();
  });
});

describe("project evidence scope (Part B3)", () => {
  it("scopes evidence, chats and new sessions to the project and clears with the chip", async () => {
    const onClearProject = vi.fn();
    routes["POST /api/skills/improve/start"] = ok({ session_id: "imp-p" });
    render(
      <SkillImprovePanel
        name="quotation-builder"
        profile="default"
        content={LIVE}
        onOpenTab={onOpenTab}
        project={{ slug: "q3", name: "Q3 pricing" }}
        onClearProject={onClearProject}
      />,
    );
    expect(screen.getByText("Evidence: project Q3 pricing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All runs" }));
    await waitFor(() => expect(screen.getAllByText(/Q3 pricing/).length).toBeGreaterThan(1));
    expect(screen.queryByText("Quote for ACME (USD)")).toBeNull();
    expect(String(callsTo("GET /api/skills/usage/detail")[0][0])).toContain("&project=q3");
    expect(String(callsTo("GET /api/skills/improve/sessions")[0][0])).toContain("&project=q3");

    fireEvent.click(screen.getByRole("button", { name: "New improve chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(callsTo("POST /api/skills/improve/start")).toHaveLength(1));
    expect(bodyOf(callsTo("POST /api/skills/improve/start")[0])).toEqual({ name: "quotation-builder", project: "q3" });

    fireEvent.click(screen.getByRole("button", { name: "Show runs from everywhere" }));
    expect(onClearProject).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateSkillSheet } from "@/components/projects/skills/CreateSkillSheet";
import { I18nProvider } from "@/i18n";
import en from "@/i18n/messages/en/projects.json";
import { draftSkillName } from "@/lib/skills/create";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const DRAFT = "---\nname: digest-tone\ndescription: Keep the digest conversational.\n---\n\n# Digest tone\n";
const BOARD = {
  columns: [
    { name: "done", tasks: [
      { id: "t1", ref: "T1", title: "Draft the digest", status: "done", result: "Readers liked it", created_at: 1, completed_at: 3 },
      { id: "t2", ref: "T2", title: "Collect links", status: "done", result: null, created_at: 1, completed_at: 2 },
    ] },
    { name: "todo", tasks: [{ id: "t3", title: "Next issue", status: "todo", created_at: 4, completed_at: null }] },
  ],
};

type Route = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Route>;
const fetchMock = vi.fn();
const ok = (body: unknown) => () => ({ body });
function respond(url: string, init?: RequestInit) {
  const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
  const route = routes[key];
  if (!route) throw new Error(`unexpected ${key}`);
  const { status = 200, body } = route(init);
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}
const bodyOf = (key: string, i = 0) =>
  JSON.parse(String((fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(u)}` === key)[i][1] as RequestInit).body));

beforeEach(() => {
  routes = {
    "GET /api/projects/digest/board": ok(BOARD),
    "POST /api/skills/create/start": ok({ session_id: "skillnew_1_abcd1234" }),
    "POST /api/skills/create/message": ok({ reply: "Here it is:\n````skill-draft\n" + DRAFT + "````", draft: DRAFT }),
    "POST /api/skills/create/save": ok({ name: "digest-tone", enabled: false, created_here: true, version: { id: "v1", n: 1, status: "draft" } }),
    "PATCH /api/projects/digest/tools": ok({ skills: ["email", "digest-tone"] }),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(respond);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sheet(props: Partial<Parameters<typeof CreateSkillSheet>[0]> = {}) {
  const onCreated = vi.fn();
  render(
    <I18nProvider locale="en" messages={{ projects: en }}>
      <CreateSkillSheet slug="digest" projectName="Monday digest" profile="coder" onClose={() => {}} onCreated={onCreated} {...props} />
    </I18nProvider>,
  );
  return { onCreated };
}

describe("draftSkillName", () => {
  it("reads a valid frontmatter name only", () => {
    expect(draftSkillName(DRAFT)).toBe("digest-tone");
    expect(draftSkillName("---\nname: Bad Name\n---\n")).toBeNull();
    expect(draftSkillName("# no frontmatter")).toBeNull();
  });
});

describe("CreateSkillSheet", () => {
  it("drafts from the goal and done cards, refines, saves a disabled draft and preloads", async () => {
    const { onCreated } = sheet({ canPreload: true, preloaded: ["email"], candidate: { id: "c1", name: "digest-tone", body: "Be casual" } });
    expect(await screen.findByText("Draft the digest")).toBeTruthy();
    expect(screen.queryByText("Next issue")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Collect links/));
    fireEvent.change(screen.getByLabelText("What should the skill do?"), { target: { value: "Write the digest in our voice" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft it" }));

    expect(await screen.findByDisplayValue("digest-tone")).toBeTruthy();
    expect(bodyOf("POST /api/skills/create/start")).toEqual({
      profile: "coder", project: "digest", goal: "Write the digest in our voice", candidate_id: "c1", card_ids: ["t1"],
    });
    expect(bodyOf("POST /api/skills/create/message")).toEqual({
      session_id: "skillnew_1_abcd1234", text: "Write the digest in our voice", profile: "coder",
    });
    expect(screen.getByText("Here it is:")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Message the agent"), { target: { value: "shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodyOf("POST /api/skills/create/message", 1).text).toBe("shorter"));

    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(await screen.findByText("digest-tone saved as a disabled draft")).toBeTruthy();
    expect(bodyOf("POST /api/skills/create/save")).toEqual({
      profile: "coder", project: "digest", name: "digest-tone", content: DRAFT,
      session_id: "skillnew_1_abcd1234", candidate_id: "c1",
    });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "digest-tone", enabled: false }));
    expect(screen.getByRole("link", { name: "Enable from Versions" }).getAttribute("href")).toBe("/skills/digest-tone?profile=coder&tab=versions");

    fireEvent.click(screen.getByRole("button", { name: "Preload in this project's runs" }));
    expect(await screen.findByText(/Preloaded in this project's runs/)).toBeTruthy();
    expect(bodyOf("PATCH /api/projects/digest/tools")).toEqual({ skills: ["email", "digest-tone"] });
  });

  it("hides preload for non-leads and shows a name collision", async () => {
    routes["POST /api/skills/create/save"] = () => ({ status: 409, body: { detail: "A skill named 'digest-tone' already exists in this profile." } });
    sheet();
    fireEvent.change(await screen.findByLabelText("What should the skill do?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft it" }));
    await screen.findByDisplayValue("digest-tone");
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preload in this project's runs" })).toBeNull();
  });

  it("cannot save until the name is valid", async () => {
    sheet();
    fireEvent.change(await screen.findByLabelText("What should the skill do?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft it" }));
    const nameBox = await screen.findByDisplayValue("digest-tone");
    fireEvent.change(nameBox, { target: { value: "Bad Name" } });
    expect((screen.getByRole("button", { name: "Save as draft" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

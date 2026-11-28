// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProfilePage } from "@/components/profiles/page/ProfilePage";
import type {
  Member,
  McpServer,
  ProfileInfo,
  ProfileStats,
  SkillLibrary,
  Source,
} from "@/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/components/skills/NewSkillModal", () => ({
  NewSkillModal: () => <div data-testid="new-skill-modal" />,
}));

const PROFILE: ProfileInfo = {
  name: "storyteller",
  is_default: false,
  description: "Writes bedtime stories",
  description_auto: false,
  creature: "manatee",
  model: "deepseek-v4.1-flash",
  provider: "deepseek",
  has_env: true,
  skill_count: 5,
  gateway_running: true,
};

const STATS: ProfileStats = {
  tokens: 146_000_000,
  cost_usd: 25.39,
  tokens_by_day: [1, 2, 3, 4, 5, 6, 7],
  chats: 148,
  messages: 3000,
  chat_sources: ["web"],
  last_active_at: Math.floor(Date.now() / 1000) - 60,
  skills_used: 5,
  top_skills: [
    { name: "skill-creator", uses: 31 },
    { name: "docx", uses: 22 },
  ],
  projects_done: 3,
  projects_running: 0,
  tasks_running: 0,
  current_task: null,
  needs_you: 0,
  channels: ["telegram"],
};

const LIBRARY: SkillLibrary = {
  profiles: ["storyteller"],
  skills: [
    {
      name: "docx",
      description: "Word docs",
      category: "docs",
      source: "shared",
      owners: [],
      used_by: [{ profile: "storyteller", enabled: true }],
      in_shared: true,
    },
    {
      name: "gmail-cleanup",
      description: "Inbox sweeper",
      category: "email",
      source: "shared",
      owners: [],
      used_by: [],
      in_shared: true,
    },
  ],
};

const SOURCES: Source[] = [
  {
    source_id: "src-1",
    channel: "email",
    address: "support@example.com",
    owner_user_id: "u1",
    display: "Support inbox",
    credential_ref: null,
    enabled: true,
    created_at: null,
    updated_at: null,
    routes: [
      {
        source_id: "src-1",
        profile: "storyteller",
        enabled: true,
        created_at: null,
        updated_at: null,
      },
    ],
  },
];

const MEMBERS: Member[] = [
  {
    user_id: "u1",
    display: "Leo",
    role: "owner",
    email: "leo@example.com",
    active: true,
    enrolled: true,
    channels: [],
    is_owner: true,
    invitation: null,
  },
];

const MCP: McpServer[] = [
  { name: "wiki", transport: "http", url: "https://x", enabled: true },
];

function renderPage(over: Partial<Parameters<typeof ProfilePage>[0]> = {}) {
  return render(
    <ProfilePage
      profile={PROFILE}
      stats={STATS}
      providers={[]}
      soul="# Be nice"
      library={LIBRARY}
      sources={SOURCES}
      sessions={[]}
      cronJobs={[]}
      mcpServers={MCP}
      members={MEMBERS}
      needsYou={[]}
      skillUses={[]}
      projects={[]}
      {...over}
    />,
  );
}

describe("ProfilePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("skill-suggestions")) {
          return new Response(
            JSON.stringify({
              ok: true,
              suggestions: [{ skill: "gmail-cleanup", score: 9, reason: "handles inboxes" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });
  afterEach(cleanup);

  it("renders the card-mirror header: name, creature·model, goal, metrics", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "storyteller" })).toBeTruthy();
    expect(screen.getByText(/Manatee · deepseek-v4\.1-flash/)).toBeTruthy();
    expect(screen.getByText("Writes bedtime stories")).toBeTruthy();
    expect(screen.getByText("146M")).toBeTruthy();
    expect(screen.getAllByText("skill-creator").length).toBeGreaterThan(0);
  });

  it("shows scored could-learn suggestions once the endpoint answers", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("9")).toBeTruthy());
    expect(screen.getByText("handles inboxes")).toBeTruthy();
  });

  it("falls back to the plain off-list when suggestions fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("gmail-cleanup")).toBeTruthy(),
    );
    expect(screen.queryByText("9")).toBeNull();
  });

  it("posts a library add when a could-learn skill is added", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("skill-suggestions")) {
        return new Response(
          JSON.stringify({
            ok: true,
            suggestions: [{ skill: "gmail-cleanup", score: 9, reason: "handles inboxes" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/api/skills/library/")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u === "/api/skills/library") {
        return new Response(JSON.stringify(LIBRARY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      void init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const add = await screen.findByRole("button", { name: "Add" });
    fireEvent.click(add);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) =>
          String(u).includes("/api/skills/library/add") && (i as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("saves the goal through the description endpoint", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("description")) {
        expect(init?.method).toBe("PUT");
        return new Response(JSON.stringify({ ok: true, description: "New goal" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    fireEvent.click(screen.getByLabelText("Edit goal"));
    fireEvent.change(screen.getByPlaceholderText(/What should this agent/), {
      target: { value: "New goal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes("description")),
      ).toBe(true),
    );
  });

  it("toggles a routed source through the routes endpoint", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/sources/src-1/routes/storyteller")) {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
        return new Response(JSON.stringify({ ok: true, route: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const toggle = screen.getByRole("switch", { name: /Support inbox/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes("/routes/storyteller")),
      ).toBe(true),
    );
  });

  it("shows enrolled people and the danger zone", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Who can use it" })).toBeTruthy();
    expect(screen.getByText("Leo")).toBeTruthy();
    expect(screen.getByText("Danger zone")).toBeTruthy();
  });

  it("puts a summary on top that links each issue to its fix", () => {
    renderPage({ profile: { ...PROFILE, model: null } });
    const summary = document.querySelector('[data-component="ProfileSummary"]') as HTMLElement;
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain("Can\u2019t run yet — no model is picked.".replace("\u2019", "'"));
    expect(screen.getAllByRole("button", { name: "Pick a model" }).length).toBeGreaterThan(0);
  });

  it("asks before turning off unused skills, then removes each once", async () => {
    const lib: SkillLibrary = {
      ...LIBRARY,
      skills: [
        ...LIBRARY.skills,
        {
          name: "faq",
          description: "",
          category: "docs",
          source: "shared",
          owners: [],
          used_by: [{ profile: "storyteller", enabled: true }],
          in_shared: true,
        },
      ],
    };
    renderPage({ library: lib });
    const button = screen.getByRole("button", { name: /Turn off 1 unused skill/ });
    fireEvent.click(button);
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /Turn off 1 unused skill/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
        String(c[0]).includes("/api/skills/library/remove"),
      );
      expect(calls.length).toBe(1);
      expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toMatchObject({ target: "storyteller", name: "faq" });
    });
  });
});

import { describe, expect, it } from "vitest";

import { buildSummary, type SummaryInput } from "@/components/profiles/page/summary";
import type { ProfileInfo, ProfileStats, SkillLibrary, Source } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

const NOW = 1_800_000_000_000;

const PROFILE: ProfileInfo = {
  name: "triage",
  is_default: false,
  description: "Sorts Telegram messages",
  description_auto: false,
  model: "gemini-2.5-flash",
  provider: "google",
  has_env: true,
  skill_count: 3,
  gateway_running: true,
};

const STATS: ProfileStats = {
  tokens: 1000,
  cost_usd: 2.4,
  tokens_by_day: [],
  chats: 7,
  messages: 40,
  chat_sources: [],
  last_active_at: NOW / 1000 - 5 * 3600,
  skills_used: 1,
  top_skills: [{ name: "reply-draft", uses: 9 }],
  projects_done: 3,
  projects_running: 0,
  tasks_running: 0,
  current_task: null,
  needs_you: 0,
  channels: [],
};

const skill = (name: string, profiles: string[]) => ({
  name,
  description: "",
  category: "",
  source: "shared" as const,
  owners: [],
  used_by: profiles.map((profile) => ({ profile, enabled: true })),
  in_shared: true,
});

const LIBRARY = {
  profiles: ["triage"],
  skills: [skill("reply-draft", ["triage"]), skill("faq", ["triage"]), skill("escalate", ["triage"]), skill("email-triage", ["triage"])],
} as SkillLibrary;

const source = (id: string, display: string, routed: boolean): Source => ({
  source_id: id,
  channel: "telegram",
  address: id,
  owner_user_id: "u1",
  display,
  credential_ref: null,
  enabled: true,
  created_at: null,
  updated_at: null,
  routes: routed ? [{ source_id: id, profile: "triage", enabled: true, created_at: null, updated_at: null }] : [],
});

const need = (id: string, title: string, hoursAgo: number) =>
  ({ id, title, severity: "approval", source: "todo", context: {}, created_at: NOW / 1000 - hoursAgo * 3600, href: "/", actions: [] }) as unknown as NeedsYouEntry;

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    profile: PROFILE,
    model: PROFILE.model,
    description: PROFILE.description,
    gatewayRunning: true,
    stats: STATS,
    library: LIBRARY,
    sources: [source("a", "Support bot", true)],
    needsYou: [],
    skillUses: [],
    now: NOW,
    ...over,
  };
}

describe("buildSummary", () => {
  it("leads with what's waiting and ranks the oldest item first", () => {
    const s = buildSummary(input({ needsYou: [need("1", "Reply to Acme", 1), need("2", "Invoice #4471", 5)] }));
    expect(s.tone).toBe("warn");
    expect(s.headline).toBe("Working well — 2 items are waiting for you.");
    expect(s.items[0].key).toBe("waiting");
    expect(s.items[0].detail).toContain("Invoice #4471");
    expect(s.checks.find((c) => c.key === "waiting")?.value).toBe("2 items · oldest 5h");
  });

  it("says it can't run without a model and puts that first", () => {
    const s = buildSummary(input({ model: null }));
    expect(s.tone).toBe("danger");
    expect(s.pill).toBe("Needs setup");
    expect(s.items[0].change.action).toEqual({ kind: "pick-model" });
  });

  it("suggests turning off skills that never ran, never the triage pipelines", () => {
    const s = buildSummary(input());
    const item = s.items.find((i) => i.key === "skills");
    expect(item?.change.action).toEqual({ kind: "turn-off-skills", skills: ["faq", "escalate"] });
    expect(s.checks.find((c) => c.key === "skills")?.value).toBe("4 on · 2 used");
  });

  it("flags message handling only when inboxes route to it", () => {
    expect(buildSummary(input({ gatewayRunning: false })).items[0].change.action).toEqual({ kind: "start-gateway" });
    const noInbox = buildSummary(input({ gatewayRunning: false, sources: [] }));
    expect(noInbox.items.some((i) => i.key === "gateway")).toBe(false);
    expect(noInbox.items.find((i) => i.key === "inboxes")?.change.action).toEqual({ kind: "add-source" });
  });

  it("names the one inbox that doesn't reach it", () => {
    const s = buildSummary(input({ sources: [source("a", "Support bot", true), source("b", "Sales WhatsApp", false)] }));
    expect(s.checks.find((c) => c.key === "inboxes")?.value).toBe("1 of 2 on · Sales WhatsApp off");
    expect(s.items.find((i) => i.key === "inboxes")?.title).toBe("Sales WhatsApp doesn't reach it");
  });

  it("is all good when nothing needs attention", () => {
    const s = buildSummary(
      input({ library: { profiles: [], skills: [skill("reply-draft", ["triage"])] } as SkillLibrary }),
    );
    expect(s.items).toEqual([]);
    expect(s.headline).toBe("Working well — nothing needs you.");
  });
});

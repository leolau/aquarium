import { activityLine, costLabel } from "@/components/profiles/profile-cards";
import { TRIAGE_SKILL_NAMES, profileSkills } from "@/components/skills/library";
import { timeAgo } from "@/lib/skills/versions";
import type { SkillUsageRow } from "@/lib/skills/usage";
import type { ProfileInfo, ProfileStats, SkillLibrary, Source } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

/** Section anchors on the agent-profile page; the summary links to them. */
export const SECTION_IDS = {
  header: "profile-header",
  rightNow: "profile-right-now",
  skills: "profile-skills",
  reach: "profile-reach",
  history: "profile-history",
  personality: "profile-personality",
  people: "profile-people",
} as const;
export type SectionKey = keyof typeof SECTION_IDS;

export type CheckState = "ok" | "warn" | "bad" | "none";
export type SummaryTone = "success" | "warn" | "danger" | "muted";

export interface SummaryCheck {
  key: string;
  state: CheckState;
  label: string;
  value: string;
  /** Short form for the phone chips. */
  chip: string;
}

export type SummaryAction =
  | { kind: "pick-model" }
  | { kind: "review-needs" }
  | { kind: "start-gateway" }
  | { kind: "edit-goal" }
  | { kind: "turn-off-skills"; skills: string[] }
  | { kind: "route-source" }
  | { kind: "add-source" }
  | { kind: "start-chat" };

export interface SummaryItem {
  key: string;
  title: string;
  detail: string;
  section: SectionKey;
  sectionLabel: string;
  change: { label: string; detail: string; action: SummaryAction };
}

export interface ProfileSummaryModel {
  tone: SummaryTone;
  pill: string;
  headline: string;
  sub: string;
  checks: SummaryCheck[];
  /** Ranked: most important first. Phone and desktop both show the first 3. */
  items: SummaryItem[];
  routedOn: number;
  sourceCount: number;
  skillsOn: number;
}

export interface SummaryInput {
  profile: ProfileInfo;
  model: string | null;
  description: string;
  gatewayRunning: boolean;
  stats: ProfileStats | null;
  library: SkillLibrary | null;
  sources: Source[];
  needsYou: NeedsYouEntry[];
  skillUses: SkillUsageRow[];
  now?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The skills switched on for the agent that never ran in the usage window. */
export function unusedSkills(
  name: string,
  library: SkillLibrary | null,
  stats: ProfileStats | null,
  skillUses: SkillUsageRow[],
): { on: string[]; unused: string[] } {
  const on = library ? profileSkills(library, name).on.map((s) => s.name) : [];
  const used = new Set([
    ...skillUses.filter((s) => s.uses > 0).map((s) => s.name),
    ...(stats?.top_skills ?? []).map((s) => s.name),
  ]);
  const unused = on.filter((s) => !used.has(s) && !TRIAGE_SKILL_NAMES.has(s));
  return { on, unused };
}

/**
 * The summary at the top of the agent-profile page: one verdict, a check per
 * setup area, and a ranked list of what to look at, each with the change
 * that fixes it. Pure — built from the data the page already loads.
 */
export function buildSummary(input: SummaryInput): ProfileSummaryModel {
  const { profile, model, description, gatewayRunning, stats, library, sources, needsYou, skillUses } = input;
  const now = input.now ?? Date.now();
  const name = profile.name;

  const routes = sources.map((s) => ({
    source: s,
    on: s.enabled && (s.routes.find((r) => r.profile === name)?.enabled ?? false),
  }));
  const routedOn = routes.filter((r) => r.on).length;
  const offSources = routes.filter((r) => !r.on && r.source.enabled).map((r) => r.source);
  const sourceCount = routes.filter((r) => r.source.enabled || r.on).length;

  const waiting = needsYou.length;
  const oldest = needsYou.reduce<NeedsYouEntry | null>(
    (a, b) => (!a || (b.created_at && b.created_at < a.created_at) ? b : a),
    null,
  );
  const oldestAge = oldest?.created_at ? timeAgo(oldest.created_at, now).replace(/ ago$/, "") : "";

  const { on: skillsOn, unused } = unusedSkills(name, library, stats, skillUses);
  const usedCount = skillsOn.length - unused.length;
  const neverUsed = !stats?.last_active_at && !stats?.current_task;
  const hasGoal = description.trim().length > 0;

  const checks: SummaryCheck[] = [
    model
      ? { key: "model", state: "ok", label: "Model", value: model, chip: "Model set" }
      : { key: "model", state: "bad", label: "Model", value: "not set", chip: "No model" },
    gatewayRunning
      ? { key: "gateway", state: "ok", label: "Message handling", value: "running", chip: "Running" }
      : {
          key: "gateway",
          state: routedOn ? "bad" : "none",
          label: "Message handling",
          value: "off",
          chip: "Messages off",
        },
    !sourceCount
      ? { key: "inboxes", state: "none", label: "Inboxes", value: "none connected", chip: "No inboxes" }
      : {
          key: "inboxes",
          state: offSources.length ? "warn" : "ok",
          label: "Inboxes",
          value: `${routedOn} of ${sourceCount} on${
            offSources.length === 1 ? ` · ${offSources[0].display || offSources[0].channel} off` : ""
          }`,
          chip: `${routedOn} of ${plural(sourceCount, "inbox", "inboxes")}`,
        },
    waiting
      ? {
          key: "waiting",
          state: "warn",
          label: "Waiting for you",
          value: `${plural(waiting, "item")}${oldestAge ? ` · oldest ${oldestAge}` : ""}`,
          chip: `${waiting} waiting`,
        }
      : { key: "waiting", state: "ok", label: "Waiting for you", value: "nothing", chip: "Nothing waiting" },
    hasGoal
      ? { key: "goal", state: "ok", label: "Goal", value: "set", chip: "Goal set" }
      : { key: "goal", state: "warn", label: "Goal", value: "missing", chip: "No goal" },
    {
      key: "skills",
      state: !skillsOn.length ? "none" : unused.length && !neverUsed ? "warn" : neverUsed ? "none" : "ok",
      label: "Skills",
      value: !skillsOn.length
        ? "none on"
        : neverUsed
          ? `${skillsOn.length} on · never used`
          : `${skillsOn.length} on · ${usedCount} used`,
      chip: !skillsOn.length ? "No skills" : `${usedCount} of ${skillsOn.length} skills used`,
    },
  ];

  const items: SummaryItem[] = [];
  if (!model) {
    items.push({
      key: "model",
      title: "No model picked",
      detail: "Any chat or project sent to it will fail.",
      section: "personality",
      sectionLabel: "Personality",
      change: {
        label: "Pick a model",
        detail: "Opens the model list in Personality & direction.",
        action: { kind: "pick-model" },
      },
    });
  }
  if (waiting) {
    items.push({
      key: "waiting",
      title: `${plural(waiting, "item")} waiting for you`,
      detail: oldest
        ? `Oldest: ${oldest.title}${oldestAge ? `, ${timeAgo(oldest.created_at, now)}` : ""}.`
        : "Approvals and questions it can't settle alone.",
      section: "rightNow",
      sectionLabel: "Right now",
      change: {
        label: `Review ${waiting}`,
        detail: "Approve, answer or dismiss them so it can carry on.",
        action: { kind: "review-needs" },
      },
    });
  }
  if (!gatewayRunning && routedOn) {
    items.push({
      key: "gateway",
      title: "Message handling is off",
      detail: `${plural(routedOn, "inbox", "inboxes")} route to it, but nothing is answered until it runs.`,
      section: "reach",
      sectionLabel: "Reach",
      change: {
        label: "Turn on message handling",
        detail: "Starts it so it can sort and reply to its inboxes.",
        action: { kind: "start-gateway" },
      },
    });
  }
  if (!hasGoal) {
    items.push({
      key: "goal",
      title: "No goal written",
      detail: "People can't tell what to ask it, and it has no direction.",
      section: "header",
      sectionLabel: "Goal",
      change: {
        label: "Write a goal",
        detail: "One or two sentences on what it should be good at.",
        action: { kind: "edit-goal" },
      },
    });
  }
  if (unused.length && !neverUsed) {
    const names = unused.slice(0, 3).join(", ");
    items.push({
      key: "skills",
      title: `${unused.length} of ${skillsOn.length} skills unused for 90 days`,
      detail: `${names}${unused.length > 3 ? ` and ${unused.length - 3} more` : ""} never ran.`,
      section: "skills",
      sectionLabel: "Skills",
      change: {
        label: `Turn off ${plural(unused.length, "unused skill")}`,
        detail: "Shorter instructions, faster and cheaper replies. Easy to undo.",
        action: { kind: "turn-off-skills", skills: unused },
      },
    });
  }
  if (offSources.length) {
    const first = offSources[0];
    const label = first.display || first.address;
    items.push({
      key: "inboxes",
      title: offSources.length === 1 ? `${label} doesn't reach it` : `${offSources.length} of your inboxes don't reach it`,
      detail: "Messages there aren't routed to this agent.",
      section: "reach",
      sectionLabel: "Reach",
      change: {
        label: offSources.length === 1 ? `Connect ${label}` : "Connect inboxes",
        detail: "Flip the switch in Ways to reach it.",
        action: { kind: "route-source" },
      },
    });
  } else if (!sourceCount) {
    items.push({
      key: "inboxes",
      title: "No inboxes connected",
      detail: "It only answers in chats here until an email, Telegram or WhatsApp source routes to it.",
      section: "reach",
      sectionLabel: "Reach",
      change: {
        label: "Connect an inbox",
        detail: "Choose an email, Telegram or WhatsApp source.",
        action: { kind: "add-source" },
      },
    });
  }
  if (neverUsed && model) {
    items.push({
      key: "unused",
      title: "Never used",
      detail: "No chats, projects or skill uses yet.",
      section: "history",
      sectionLabel: "History",
      change: {
        label: "Try it in a chat",
        detail: "Ask it a real question to see how it does.",
        action: { kind: "start-chat" },
      },
    });
  }

  const thirtyDays = stats
    ? `${plural(stats.chats, "chat")} · ${plural(stats.projects_done, "project")} done in the last 30 days`
    : "No stats yet";
  const sub = [thirtyDays, activityLine(stats ?? undefined, now), stats ? costLabel(stats.cost_usd) : null]
    .filter(Boolean)
    .join(" · ");

  let tone: SummaryTone;
  let pill: string;
  let headline: string;
  if (!model) {
    tone = "danger";
    pill = "Needs setup";
    headline = "Can't run yet — no model is picked.";
  } else if (!gatewayRunning && routedOn) {
    tone = "danger";
    pill = "Messages off";
    headline = "Its inboxes aren't being answered — message handling is off.";
  } else if (waiting) {
    tone = "warn";
    pill = `${waiting} need${waiting === 1 ? "s" : ""} you`;
    headline = `${neverUsed ? "Set up" : stats?.current_task ? "Busy" : "Working well"} — ${plural(waiting, "item")} ${
      waiting === 1 ? "is" : "are"
    } waiting for you.`;
  } else if (neverUsed) {
    tone = "muted";
    pill = "Not used yet";
    headline = "Ready, but nobody has used it yet.";
  } else if (stats?.current_task) {
    tone = "success";
    pill = "Working now";
    headline = `Busy right now — ${stats.current_task.title ?? "working on a task"}.`;
  } else {
    tone = items.length ? "warn" : "success";
    pill = items.length ? `${plural(items.length, "tip")}` : "All good";
    headline = items.length ? "Working well — a few things could be better." : "Working well — nothing needs you.";
  }

  return {
    tone,
    pill,
    headline,
    sub: neverUsed && !stats?.chats ? `Never used · ${plural(skillsOn.length, "skill")} on` : sub,
    checks,
    items,
    routedOn,
    sourceCount,
    skillsOn: skillsOn.length,
  };
}

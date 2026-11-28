"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { Avatar, Metric, Spark, StatusPill } from "@/components/profiles/card-atoms";
import {
  activityLine,
  channelLabels,
  compactNumber,
  costLabel,
  creatureLabel,
  profileCreature,
  profileStatus,
} from "@/components/profiles/profile-cards";
import { ProfileCreaturePicker } from "@/components/profiles/ProfileCreaturePicker";
import { Section } from "@/components/profiles/page/Section";
import { RefBadge } from "@/components/refs/RefBadge";
import { SkillsGrowth } from "@/components/profiles/page/SkillsGrowth";
import { Connectors } from "@/components/profiles/page/Connectors";
import { HistoryTabs } from "@/components/profiles/page/HistoryTabs";
import {
  ProfileSummary,
  scrollToSection,
  type SummaryJump,
} from "@/components/profiles/page/ProfileSummary";
import { SECTION_IDS, buildSummary } from "@/components/profiles/page/summary";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import {
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/ui/Sheet";
import {
  BellIcon,
  CoinsIcon,
  FolderIcon,
  LoaderIcon,
  MessageIcon,
  MoreIcon,
  PencilIcon,
  SparklesIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { errorText, getJson, profilePath, sendJson } from "@/lib/admin-fetch";
import type { SkillUsageRow } from "@/lib/skills/usage";
import { useAction } from "@/lib/use-action";
import type {
  CronJob,
  Member,
  McpServer,
  ModelProviderOption,
  ProfileInfo,
  ProfileStats,
  Project,
  SessionSummary,
  SkillLibrary,
  Source,
} from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

export interface ProfilePageProps {
  profile: ProfileInfo;
  stats: ProfileStats | null;
  providers: ModelProviderOption[];
  soul: string;
  library: SkillLibrary | null;
  sources: Source[];
  sessions: SessionSummary[];
  cronJobs: CronJob[];
  mcpServers: McpServer[];
  members: Member[];
  needsYou: NeedsYouEntry[];
  skillUses: SkillUsageRow[];
  projects: Project[];
}

export function ProfilePage({
  profile,
  stats,
  providers,
  soul: initialSoul,
  library,
  sources,
  sessions,
  cronJobs,
  mcpServers,
  members,
  needsYou,
  skillUses,
  projects,
}: ProfilePageProps) {
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [model, setModel] = useState<{ provider: string | null; model: string | null }>({
    provider: profile.provider,
    model: profile.model,
  });
  const [gatewayRunning, setGatewayRunning] = useState(profile.gateway_running);
  const [skillLibrary, setSkillLibrary] = useState<SkillLibrary | null>(library);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const [editGoal, setEditGoal] = useState(false);
  const status = profileStatus({ ...profile, model: model.model, gateway_running: gatewayRunning }, stats ?? undefined);
  const channels = channelLabels(stats ?? undefined);
  const enrolled = members.some((m) => m.enrolled);

  const summary = useMemo(
    () =>
      buildSummary({
        profile: { ...profile, name },
        model: model.model,
        description,
        gatewayRunning,
        stats,
        library: skillLibrary,
        sources,
        needsYou,
        skillUses,
      }),
    [profile, name, model.model, description, gatewayRunning, stats, skillLibrary, sources, needsYou, skillUses],
  );
  const hasRightNow = Boolean(stats?.current_task) || needsYou.length > 0;
  const jumps: SummaryJump[] = [
    ...(hasRightNow
      ? [{ section: "rightNow" as const, label: "Right now", count: needsYou.length ? String(needsYou.length) : undefined, tone: "warn" as const }]
      : []),
    { section: "skills", label: "What it\u2019s good at", count: String(summary.skillsOn), tone: "muted" },
    {
      section: "reach",
      label: "Ways to reach it",
      count: summary.sourceCount ? `${summary.routedOn}/${summary.sourceCount}` : "0",
      tone: "muted",
    },
    { section: "history", label: "What it\u2019s been doing" },
    model.model
      ? { section: "personality", label: "Personality" }
      : { section: "personality", label: "Personality", count: "set model", tone: "danger" },
    ...(enrolled ? [{ section: "people" as const, label: "Who can use it" }] : []),
  ];

  const handlers = {
    onPickModel: () => {
      scrollToSection("personality");
      document.getElementById("profile-model-select")?.focus({ preventScroll: true });
    },
    onEditGoal: () => {
      setEditGoal(true);
      scrollToSection("header");
    },
    onStartGateway: async () => {
      await sendJson(profilePath(name, "gateway"), "POST");
      setGatewayRunning(true);
    },
    onTurnOffSkills: async (skills: string[]) => {
      try {
        for (const skill of skills) {
          await sendJson("/api/skills/library/remove", "POST", { target: name, name: skill });
        }
      } finally {
        try {
          const fresh = await getJson<SkillLibrary>("/api/skills/library");
          if (fresh && Array.isArray(fresh.skills)) setSkillLibrary(fresh);
        } catch {
          /* keep the last good list */
        }
        setSkillsVersion((v) => v + 1);
      }
    },
  };

  return (
    <div data-component="ProfilePage" className="flex flex-col gap-4">
      <ProfileSummary summary={summary} jumps={jumps} handlers={handlers} />
      <div id={SECTION_IDS.header} className="scroll-mt-20">
        <HeaderCard
          profile={profile}
          name={name}
          description={description}
          modelLabel={model.model ?? "no model set"}
          status={status}
          stats={stats}
          channels={channels}
          editGoal={editGoal}
          onEditGoal={setEditGoal}
          onDescription={setDescription}
        />
      </div>
      <div id={SECTION_IDS.rightNow} className="scroll-mt-20 empty:hidden">
        <RightNow stats={stats} needsYou={needsYou} />
      </div>
      <div id={SECTION_IDS.skills} className="scroll-mt-20">
        <SkillsGrowth
          key={skillsVersion}
          profile={name}
          stats={stats}
          library={skillLibrary}
          skillUses={skillUses}
        />
      </div>
      <div id={SECTION_IDS.reach} className="scroll-mt-20">
        <Connectors
          profile={name}
          sources={sources}
          mcpServers={mcpServers}
          gatewayRunning={gatewayRunning}
        />
      </div>
      <div id={SECTION_IDS.history} className="scroll-mt-20">
        <HistoryTabs
          sessions={sessions}
          projects={projects}
          cronJobs={cronJobs}
          skillUses={skillUses}
        />
      </div>
      <div id={SECTION_IDS.personality} className="scroll-mt-20">
        <Personality
          name={name}
          soul={initialSoul}
          model={model}
          providers={providers}
          onModel={setModel}
        />
      </div>
      <div id={SECTION_IDS.people} className="scroll-mt-20 empty:hidden">
        <People members={members} />
      </div>
      <DangerZone
        name={name}
        isDefault={profile.is_default}
        onRenamed={(next) => {
          setName(next);
          router.replace(`/profiles/${encodeURIComponent(next)}`);
        }}
        onDeleted={() => router.replace("/profiles")}
      />
    </div>
  );
}

/* ── Header: mirrors the grid card, everything editable in place ─────────── */

function HeaderCard({
  profile,
  name,
  description,
  modelLabel,
  status,
  stats,
  channels,
  editGoal,
  onEditGoal: setEditGoal,
  onDescription,
}: {
  profile: ProfileInfo;
  name: string;
  description: string;
  modelLabel: string;
  status: ReturnType<typeof profileStatus>;
  stats: ProfileStats | null;
  channels: string[];
  editGoal: boolean;
  onEditGoal: (v: boolean) => void;
  onDescription: (d: string) => void;
}) {
  const [pickCreature, setPickCreature] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);
  const top = stats?.top_skills ?? [];
  const used = stats?.skills_used ?? 0;
  const total = profile.skill_count || used;

  return (
    <Section title="" className="!p-0">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label="Change creature"
            title="Tap to change the creature"
            className="transition hover:opacity-80"
            onClick={() => setPickCreature((v) => !v)}
          >
            <Avatar profile={{ ...profile, name }} size={56} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{name}</h1>
              <RefBadge value={profile.ref} />
              {profile.is_default ? <Pill tone="muted">default</Pill> : null}
            </div>
            <p className="truncate text-xs text-[var(--color-muted)]">
              {creatureLabel(profileCreature(profile))} · {modelLabel}
            </p>
          </div>
          <StatusPill status={status} needs={stats?.needs_you} />
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-label="More actions"
              className={`${secondaryButtonClass} !px-2`}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreIcon size={14} />
            </button>
            {menuOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
                <MenuItem hint="Opens the creature picker" onClick={() => { setMenuOpen(false); setPickCreature(true); }}>
                  Change creature
                </MenuItem>
                <MenuItem hint="Opens the goal editor" onClick={() => { setMenuOpen(false); setEditGoal(true); }}>
                  Edit goal
                </MenuItem>
                <MenuItem
                  hint="Jumps to the rename and delete controls"
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    document
                      .getElementById("profile-danger-zone")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  Rename or delete…
                </MenuItem>
              </div>
            ) : null}
          </div>
        </div>

        {pickCreature ? (
          <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <ProfileCreaturePicker
              profile={name}
              value={profileCreature(profile)}
              onSaved={() => setPickCreature(false)}
            />
          </div>
        ) : null}

        <GoalBlock
          name={name}
          description={description}
          editing={editGoal}
          onEdit={setEditGoal}
          onSaved={onDescription}
        />

        <p className="mt-3 text-xs text-[var(--color-muted)]">
          {activityLine(stats ?? undefined)}
          {channels.length ? ` · ${channels.join(", ")}` : ""}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric
            icon={<CoinsIcon size={12} />}
            label="Tokens"
            tip="Tokens this agent used in the last 30 days."
            value={stats ? compactNumber(stats.tokens) : "—"}
            sub={stats ? costLabel(stats.cost_usd) : "no stats yet"}
            extra={stats ? <Spark values={stats.tokens_by_day} /> : undefined}
          />
          <Metric
            icon={<SparklesIcon size={12} />}
            label="Skills"
            tip="Skills used at least once out of the ones turned on for this agent."
            value={`${used}/${total}`}
            sub={top[0] ? `top: ${top[0].name}` : "none used yet"}
          />
          <Metric
            icon={<FolderIcon size={12} />}
            label="Projects"
            tip="Finished projects and ones running right now."
            value={stats?.projects_done ?? 0}
            sub={`${stats?.projects_running ?? 0} running · ${stats?.tasks_running ?? 0} tasks`}
          />
          <Metric
            icon={<MessageIcon size={12} />}
            label="Chats · 30d"
            tip="Conversations in the last 30 days."
            value={stats?.chats ?? 0}
            sub={channels.length ? channels.join(" · ") : "no channels yet"}
          />
        </div>

        {top.length ? (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)]"
                style={{ width: `${Math.min(100, Math.round((used / Math.max(total, 1)) * 100))}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--color-muted)]">Top:</span>
              {top.slice(0, 4).map((s) => (
                <Pill key={s.name} tone="muted">
                  {s.name}
                </Pill>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function MenuItem({
  children,
  onClick,
  hint,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  hint: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-appmcp-hint={hint}
      className={`block w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-surface-2)] ${
        danger ? "text-[var(--color-danger)]" : ""
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ── Goal ────────────────────────────────────────────────────────────────── */

function GoalBlock({
  name,
  description,
  editing,
  onEdit,
  onSaved,
}: {
  name: string;
  description: string;
  editing: boolean;
  onEdit: (v: boolean) => void;
  onSaved: (d: string) => void;
}) {
  const [draft, setDraft] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const { run: save, pending } = useAction(async () => {
    setError(null);
    try {
      const out = await sendJson<{ description: string }>(
        profilePath(name, "description"),
        "PUT",
        { description: draft },
      );
      onSaved(out.description ?? draft);
      onEdit(false);
    } catch (err) {
      setError(errorText(err));
    }
  });
  const { run: rewrite, pending: rewriting } = useAction(async () => {
    setError(null);
    try {
      const out = await sendJson<{ ok: boolean; description?: string | null; reason?: string | null }>(
        profilePath(name, "describe-auto"),
        "POST",
        { overwrite: true },
      );
      if (out.ok && out.description) {
        setDraft(out.description);
        onSaved(out.description);
        onEdit(false);
      } else {
        setError(out.reason || "Couldn't write a goal from its history yet.");
      }
    } catch (err) {
      setError(errorText(err));
    }
  });

  return (
    <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase text-[var(--color-muted)]">Goal</span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
            disabled={rewriting}
            onClick={() => void rewrite()}
            title="Let Hermes rewrite the goal from what this agent actually does"
          >
            {rewriting ? "Writing…" : "Rewrite with AI"}
          </button>
          <button
            type="button"
            aria-label="Edit goal"
            className="text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            onClick={() => {
              setDraft(description);
              onEdit(!editing);
            }}
          >
            <PencilIcon size={12} />
          </button>
        </span>
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            className={`${inputClass} min-h-20 resize-y`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What should this agent be good at?"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-appmcp-hint="Saves the goal"
              className={primaryButtonClass}
              disabled={pending}
              onClick={() => void save()}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" data-appmcp-hint="Discards the goal edits" className={secondaryButtonClass} onClick={() => onEdit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-sm">
          {description || <span className="text-[var(--color-muted)]">No goal yet — write one so people know what to ask it.</span>}
        </p>
      )}
      {error ? <InlineAlert tone="danger" className="mt-2">{error}</InlineAlert> : null}
    </div>
  );
}

/* ── Right now ───────────────────────────────────────────────────────────── */

function RightNow({
  stats,
  needsYou,
}: {
  stats: ProfileStats | null;
  needsYou: NeedsYouEntry[];
}) {
  if (!stats?.current_task && needsYou.length === 0) return null;
  return (
    <Section
      title={
        <span className="flex items-center gap-1.5">
          <BellIcon size={13} /> Right now
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {stats?.current_task ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm">
            <span className="font-medium">Working on: </span>
            {stats.current_task.title ??
              (stats.current_task.kind === "project" ? "a project" : "a task")}
          </div>
        ) : null}
        {needsYou.length ? (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]">
            {needsYou.slice(0, 8).map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-3 py-2">
                <Pill tone={item.severity === "blocking" ? "danger" : item.severity === "approval" ? "warning" : "muted"}>
                  {item.severity}
                </Pill>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{item.title}</p>
                  {item.detail ? (
                    <p className="truncate text-xs text-[var(--color-muted)]">{item.detail}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {needsYou.length > 8 ? (
          <p className="text-xs text-[var(--color-muted)]">
            …and {needsYou.length - 8} more — see the Needs-you list on the home page.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

/* ── Personality & direction: SOUL.md + model ────────────────────────────── */

function Personality({
  name,
  soul,
  model,
  providers,
  onModel,
}: {
  name: string;
  soul: string;
  model: { provider: string | null; model: string | null };
  providers: ModelProviderOption[];
  onModel: (m: { provider: string; model: string }) => void;
}) {
  const [draft, setDraft] = useState(soul);
  const [editingSoul, setEditingSoul] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [soulSaved, setSoulSaved] = useState(false);
  const [choice, setChoice] = useState(model.provider && model.model ? `${model.provider}/${model.model}` : "");
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelSaved, setModelSaved] = useState(false);

  const modelChoices = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({
          value: `${p.slug}/${m}`,
          label: `${m} · ${p.name}`,
          provider: p.slug,
          model: m,
        })),
      ),
    [providers],
  );

  const { run: saveSoul, pending: savingSoul } = useAction(async () => {
    setSoulError(null);
    setSoulSaved(false);
    try {
      await sendJson(profilePath(name, "soul"), "PUT", { content: draft });
      setSoulSaved(true);
      setEditingSoul(false);
    } catch (err) {
      setSoulError(errorText(err));
    }
  });

  const { run: saveModel, pending: savingModel } = useAction(async () => {
    setModelError(null);
    setModelSaved(false);
    const picked = modelChoices.find((c) => c.value === choice);
    if (!picked) {
      setModelError("Pick a model first.");
      return;
    }
    try {
      await sendJson(profilePath(name, "model"), "PUT", {
        provider: picked.provider,
        model: picked.model,
      });
      onModel({ provider: picked.provider, model: picked.model });
      setModelSaved(true);
    } catch (err) {
      setModelError(errorText(err));
    }
  });

  return (
    <Section
      title="Personality & direction"
      hint="Its soul — how it talks and behaves — and the model that thinks for it. Edits apply to the next chat."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium">SOUL.md</label>
            {!editingSoul ? (
              <button
                type="button"
                data-appmcp-hint="Opens the SOUL.md editor"
                className="text-[11px] text-[var(--color-accent)] hover:underline"
                onClick={() => {
                  setDraft(soul);
                  setEditingSoul(true);
                }}
              >
                Edit
              </button>
            ) : null}
          </div>
          {editingSoul ? (
            <>
              <textarea
                className={`${inputClass} min-h-48 font-mono text-xs`}
                placeholder="The agent's personality…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-appmcp-hint="Saves SOUL.md"
                  className={primaryButtonClass}
                  disabled={savingSoul}
                  onClick={() => void saveSoul()}
                >
                  {savingSoul ? "Saving…" : "Save soul"}
                </button>
                <button
                  type="button"
                  data-appmcp-hint="Discards the SOUL.md edits"
                  className={secondaryButtonClass}
                  onClick={() => {
                    setDraft(soul);
                    setEditingSoul(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 font-mono text-xs text-[var(--color-muted)]">
              {soul || "(no SOUL.md yet)"}
            </pre>
          )}
          {soulSaved ? <p className="mt-1 text-xs text-[var(--color-success)]">Saved.</p> : null}
          {soulError ? <InlineAlert tone="danger" className="mt-2">{soulError}</InlineAlert> : null}
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium">Model</label>
          <select
            id="profile-model-select"
            className={inputClass}
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
              setModelSaved(false);
            }}
          >
            <option value="">Pick a model…</option>
            {modelChoices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {choice && choice !== `${model.provider}/${model.model}` ? (
            <button
              type="button"
              data-appmcp-hint="Saves the model choice"
              className={`${primaryButtonClass} mt-2`}
              disabled={savingModel}
              onClick={() => void saveModel()}
            >
              {savingModel ? "Saving…" : "Save model"}
            </button>
          ) : null}
          {modelSaved ? <p className="mt-1 text-xs text-[var(--color-success)]">Saved.</p> : null}
          {modelError ? <InlineAlert tone="danger" className="mt-2">{modelError}</InlineAlert> : null}
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            The goal and soul shape <em>how</em> it works; the model is <em>how well</em> it thinks.
            Adjust them over time as you see what it&apos;s good at.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ── Who can use it ──────────────────────────────────────────────────────── */

function People({ members }: { members: Member[] }) {
  const enrolled = members.filter((m) => m.enrolled);
  if (!enrolled.length) return null;
  return (
    <Section
      title="Who can use it"
      hint="People enrolled on this agent — they can chat with it and get its replies."
    >
      <ul className="divide-y divide-[var(--color-border)]">
        {enrolled.map((m) => (
          <li key={m.user_id} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">
              {m.display || m.email || m.user_id}
            </span>
            {!m.active ? <Pill tone="warning">suspended</Pill> : null}
            <Pill tone={m.is_owner ? "accent" : "muted"}>{m.role}</Pill>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ── Danger zone ─────────────────────────────────────────────────────────── */

function DangerZone({
  name,
  isDefault,
  onRenamed,
  onDeleted,
}: {
  name: string;
  isDefault: boolean;
  onRenamed: (next: string) => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [next, setNext] = useState(name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { run: rename, pending: renamingNow } = useAction(async () => {
    setError(null);
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) {
      setRenaming(false);
      return;
    }
    try {
      await sendJson(profilePath(name), "PATCH", { new_name: trimmed });
      onRenamed(trimmed);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRenaming(false);
    }
  });

  const { run: del, pending: deleting } = useAction(async () => {
    setError(null);
    try {
      await sendJson(profilePath(name), "DELETE");
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setConfirming(false);
    }
  });

  return (
    <div id="profile-danger-zone">
      <Section
        title={<span className="text-[var(--color-danger)]">Danger zone</span>}
        hint={
          isDefault
            ? "The default agent can't be renamed or deleted."
            : "Careful — these apply right away."
        }
      >
        {error ? <InlineAlert tone="danger" className="mb-2">{error}</InlineAlert> : null}
        <div className="flex flex-wrap items-center gap-2">
          {renaming ? (
            <>
              <input
                className={`${inputClass} !w-56`}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="New profile name"
              />
              <button
                type="button"
                data-appmcp-hint="Renames the profile"
                className={primaryButtonClass}
                disabled={renamingNow}
                onClick={() => void rename()}
              >
                {renamingNow ? "Renaming…" : "Rename"}
              </button>
              <button type="button" data-appmcp-hint="Cancels renaming" className={secondaryButtonClass} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              data-appmcp-hint="Opens the rename field"
              className={secondaryButtonClass}
              disabled={isDefault}
              onClick={() => {
                setNext(name);
                setRenaming(true);
              }}
            >
              <PencilIcon size={12} className="mr-1 inline" /> Rename
            </button>
          )}
          <button
            type="button"
            className={dangerButtonClass}
            disabled={isDefault}
            onClick={() => setConfirming(true)}
          >
            <TrashIcon size={12} className="mr-1 inline" /> Delete profile
          </button>
        </div>
        {confirming ? (
          <ConfirmDialog
            title={`Delete ${name}?`}
            body="Its chats, memory, skills setup and files are removed for good. This can't be undone."
            confirmLabel={deleting ? "Deleting…" : "Delete"}
            onConfirm={() => void del()}
            onCancel={() => setConfirming(false)}
          />
        ) : null}
      </Section>
    </div>
  );
}

/* Loader re-exported for child sections. */
export function InlineLoader({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
      <LoaderIcon size={12} className="animate-spin" /> {label}
    </span>
  );
}

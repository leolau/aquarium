"use client";

import Link from "next/link";
import { useState } from "react";

import {
  SECTION_IDS,
  type CheckState,
  type ProfileSummaryModel,
  type SectionKey,
  type SummaryAction,
  type SummaryItem,
  type SummaryTone,
} from "@/components/profiles/page/summary";
import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InfoTip } from "@/components/ui/InfoTip";
import { InlineAlert } from "@/components/ui/InlineAlert";
import {
  AlertIcon,
  BellIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
} from "@/components/ui/icons";
import { errorText } from "@/lib/admin-fetch";

const TONE_BORDER: Record<SummaryTone, string> = {
  success: "border-[var(--color-success)]/50",
  warn: "border-[var(--color-warn)]/55",
  danger: "border-[var(--color-danger)]/55",
  muted: "border-[var(--color-border)]",
};
const TONE_ICON: Record<SummaryTone, string> = {
  success: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  warn: "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]",
  danger: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  muted: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};
const CHECK_TEXT: Record<CheckState, string> = {
  ok: "text-[var(--color-muted)]",
  warn: "text-[var(--color-warn-text)]",
  bad: "text-[var(--color-danger)]",
  none: "text-[var(--color-muted)]",
};

export interface SummaryJump {
  section: SectionKey;
  label: string;
  count?: string;
  tone?: "warn" | "danger" | "muted";
}

export interface ProfileSummaryHandlers {
  onPickModel: () => void;
  onEditGoal: () => void;
  onStartGateway: () => Promise<void>;
  onTurnOffSkills: (skills: string[]) => Promise<void>;
}

/** Scroll to a page section; the summary's look-at rows and jump pills use it. */
export function scrollToSection(section: SectionKey) {
  document.getElementById(SECTION_IDS[section])?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * The top-of-page summary: how the agent is doing, what to look at and what
 * to change, with a jump bar to every section below. Phone stacks it; the
 * setup checks become chips and only the first change shows until expanded.
 */
export function ProfileSummary({
  summary,
  jumps,
  handlers,
}: {
  summary: ProfileSummaryModel;
  jumps: SummaryJump[];
  handlers: ProfileSummaryHandlers;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState<SummaryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const items = summary.items.slice(0, 3);
  const changes = summary.items.slice(0, 4);
  const HeadIcon = summary.tone === "danger" ? AlertIcon : summary.tone === "success" ? CheckIcon : BellIcon;

  const navigate = (action: SummaryAction) => {
    switch (action.kind) {
      case "pick-model":
        handlers.onPickModel();
        return;
      case "edit-goal":
        handlers.onEditGoal();
        return;
      case "review-needs":
        scrollToSection("rightNow");
        return;
      case "route-source":
        scrollToSection("reach");
        return;
      default:
        return;
    }
  };

  const confirmed = async (item: SummaryItem) => {
    setError(null);
    try {
      if (item.change.action.kind === "start-gateway") await handlers.onStartGateway();
      if (item.change.action.kind === "turn-off-skills") await handlers.onTurnOffSkills(item.change.action.skills);
      setDone(item.key);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setConfirm(null);
    }
  };

  return (
    <section
      data-component="ProfileSummary"
      aria-label="Summary"
      className={`rounded-[var(--radius-lg)] border bg-[var(--color-surface)] p-3.5 md:p-5 ${TONE_BORDER[summary.tone]}`}
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] ${TONE_ICON[summary.tone]}`}>
          <HeadIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Summary · last 30 days
            </p>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium md:hidden ${TONE_ICON[summary.tone]}`}>
              {summary.pill}
            </span>
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug md:text-lg">{summary.headline}</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{summary.sub}</p>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1 md:flex">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TONE_ICON[summary.tone]}`}>{summary.pill}</span>
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
            <ClockIcon size={11} /> Updated just now · rebuilt each visit
          </span>
        </div>
      </div>

      {error ? <InlineAlert tone="danger" className="mt-3">{error}</InlineAlert> : null}

      <div className="mt-3 grid gap-3 md:mt-4 lg:grid-cols-3">
        <Panel
          title="Current situation"
          tip="One line per part of its setup. Green is fine, amber deserves a look, red stops it from working."
        >
          <ul className="hidden flex-col gap-2 md:flex">
            {summary.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                <CheckMark state={c.state} />
                <span className="flex-1">{c.label}</span>
                <span className={`truncate text-xs ${CHECK_TEXT[c.state]}`}>{c.value}</span>
              </li>
            ))}
          </ul>
          <ul className="flex flex-wrap gap-1.5 md:hidden">
            {summary.checks
              .filter((c) => c.state !== "ok" || c.key === "model" || c.key === "gateway")
              .map((c) => (
                <li
                  key={c.key}
                  className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
                >
                  <CheckMark state={c.state} small /> {c.chip}
                </li>
              ))}
          </ul>
        </Panel>

        <Panel
          title="What to look at"
          tip="The most important things first. Tap one to jump to the part of the page with the details."
        >
          {items.length ? (
            <ol className="flex flex-col gap-2">
              {items.map((item, i) => (
                <li key={item.key}>
                  <button
                    type="button"
                    data-appmcp-hint={`Jumps to ${item.sectionLabel}`}
                    onClick={() => scrollToSection(item.section)}
                    className="flex w-full items-start gap-2.5 rounded-[var(--radius-md)] p-1.5 text-left hover:bg-[var(--color-surface)] max-md:border max-md:border-[var(--color-border)] max-md:bg-[var(--color-surface)] max-md:p-2.5"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[11px] font-medium text-[var(--color-muted)] max-md:bg-[var(--color-surface-2)]">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{item.title}</span>
                      <span className="block text-xs text-[var(--color-muted)]">{item.detail}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-accent)]">
                      <span className="hidden md:inline">{item.sectionLabel}</span>
                      <ChevronRightIcon size={12} />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Nothing to look at — it&apos;s set up and keeping up.</p>
          )}
        </Panel>

        <Panel
          title="Suggested changes"
          tip="Each one fixes an item on the left. Changes that save something ask you to confirm first, and every button locks while it works."
        >
          {changes.length ? (
            <ul className="flex flex-col gap-2">
              {changes.map((item, i) => (
                <li
                  key={item.key}
                  className={`flex-col gap-1 md:flex-row md:items-center md:gap-2.5 ${
                    i === 0 || moreOpen ? "flex" : "hidden md:flex"
                  }`}
                >
                  <ChangeButton
                    item={item}
                    primary={i === 0}
                    done={done === item.key}
                    onNavigate={() => navigate(item.change.action)}
                    onConfirm={() => setConfirm(item)}
                  />
                  <span className="text-xs text-[var(--color-muted)] md:flex-1">{item.change.detail}</span>
                </li>
              ))}
              {changes.length > 1 ? (
                <li className="md:hidden">
                  <button
                    type="button"
                    aria-expanded={moreOpen}
                    className="flex items-center gap-1 text-xs text-[var(--color-accent)]"
                    onClick={() => setMoreOpen((v) => !v)}
                  >
                    {moreOpen ? "Fewer suggestions" : `${changes.length - 1} more suggestion${changes.length > 2 ? "s" : ""}`}
                    <ChevronDownIcon size={12} className={moreOpen ? "rotate-180" : ""} />
                  </button>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">No changes needed right now.</p>
          )}
        </Panel>
      </div>

      <nav aria-label="Jump to" className="-mx-3.5 mt-3 flex items-center gap-1.5 overflow-x-auto px-3.5 pb-1 md:mx-0 md:mt-4 md:flex-wrap md:px-0">
        <span className="shrink-0 text-[11px] text-[var(--color-muted)]">Jump to</span>
        {jumps.map((j) => (
          <a
            key={j.section}
            href={`#${SECTION_IDS[j.section]}`}
            onClick={(e) => {
              e.preventDefault();
              scrollToSection(j.section);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:border-[var(--color-accent)]"
          >
            {j.label}
            {j.count ? (
              <span
                className={`rounded-full px-1.5 text-[10px] ${
                  j.tone === "warn"
                    ? "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]"
                    : j.tone === "danger"
                      ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                      : "bg-[var(--color-surface)] text-[var(--color-muted)]"
                }`}
              >
                {j.count}
              </span>
            ) : null}
          </a>
        ))}
      </nav>

      {confirm ? (
        <ConfirmDialog
          tone="accent"
          title={confirm.change.label + "?"}
          body={confirmBody(confirm)}
          confirmLabel={confirm.change.label}
          onConfirm={() => confirmed(confirm)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </section>
  );
}

function confirmBody(item: SummaryItem): string {
  const a = item.change.action;
  if (a.kind === "turn-off-skills") {
    return `These stop loading for this agent: ${a.skills.join(", ")}. The files stay in the skill library, so you can turn any of them back on under What it's good at.`;
  }
  return "Starts its message handling so it sorts and answers the inboxes routed to it. It keeps running until it is stopped.";
}

function ChangeButton({
  item,
  primary,
  done,
  onNavigate,
  onConfirm,
}: {
  item: SummaryItem;
  primary: boolean;
  done: boolean;
  onNavigate: () => void;
  onConfirm: () => void;
}) {
  const cls = `inline-flex shrink-0 items-center justify-center gap-1 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 max-md:w-full max-md:py-2 ${
    primary
      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
      : "border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]"
  }`;
  const a = item.change.action;
  if (done) {
    return (
      <span className={`${cls} !bg-[var(--color-success)]/15 !text-[var(--color-success)]`}>
        <CheckIcon size={12} /> Done
      </span>
    );
  }
  if (a.kind === "add-source") {
    return (
      <Link href="/sources" data-appmcp-hint="Opens the Sources page" className={cls}>
        {item.change.label}
      </Link>
    );
  }
  if (a.kind === "start-chat") {
    return (
      <Link href="/chat?new=1" data-appmcp-hint="Opens a new chat" className={cls}>
        {item.change.label}
      </Link>
    );
  }
  if (a.kind === "start-gateway" || a.kind === "turn-off-skills") {
    return (
      <ActionButton className={cls} data-appmcp-hint="Asks you to confirm first" onAction={onConfirm}>
        {item.change.label}
      </ActionButton>
    );
  }
  return (
    <button type="button" className={cls} data-appmcp-hint={item.change.detail} onClick={onNavigate}>
      {item.change.label}
    </button>
  );
}

function Panel({ title, tip, children }: { title: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 max-md:border-0 max-md:bg-transparent max-md:p-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h3>
        <InfoTip label={`About ${title.toLowerCase()}`} align="end">
          {tip}
        </InfoTip>
      </div>
      {children}
    </div>
  );
}

function CheckMark({ state, small = false }: { state: CheckState; small?: boolean }) {
  const size = small ? 10 : 11;
  const box = small ? "h-3.5 w-3.5" : "h-4 w-4";
  if (state === "ok")
    return (
      <span aria-label="OK" className={`flex ${box} items-center justify-center rounded-full bg-[var(--color-success)]/20 text-[var(--color-success)]`}>
        <CheckIcon size={size} />
      </span>
    );
  if (state === "warn")
    return (
      <span aria-label="Look" className={`flex ${box} items-center justify-center rounded-full bg-[var(--color-warn)]/20 text-[10px] font-bold text-[var(--color-warn-text)]`}>
        !
      </span>
    );
  if (state === "bad")
    return (
      <span aria-label="Problem" className={`flex ${box} items-center justify-center rounded-full bg-[var(--color-danger)]/20 text-[10px] font-bold text-[var(--color-danger)]`}>
        ×
      </span>
    );
  return (
    <span aria-label="Not set" className={`flex ${box} items-center justify-center rounded-full bg-[var(--color-surface)] text-[10px] text-[var(--color-muted)]`}>
      –
    </span>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { ChevronRightIcon, CpuIcon, SparklesIcon } from "@/components/ui/icons";

/** One hub card (Figma `hub-card` 16:231); `locked` renders the admin-only explanation instead of a link. */
export interface HubCard {
  id: string;
  href: string;
  name: string;
  desc: string;
  /** Count line; `null` when it failed to load (shown as the unknown dash). */
  meta: string | null;
  icon: ReactNode;
  adminChip?: boolean;
  /** Engineer-facing: shown only while the hub's Advanced switch is on. */
  advanced?: boolean;
  locked?: { why: string } | null;
}

export interface HubGroup {
  id: string;
  label: string;
  cards: HubCard[];
}

const svg = (path: ReactNode) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {path}
  </svg>
);

export const HUB_ICONS: Record<string, ReactNode> = {
  profiles: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5" /></>),
  skills: <SparklesIcon size={20} />,
  memory: svg(<><path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 9.5 3Z" /><path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h0a2.5 2.5 0 0 1-2.5-2.5v-11A2.5 2.5 0 0 1 14.5 3Z" /></>),
  graph: svg(<><rect x="9" y="2.5" width="6" height="5" rx="1" /><rect x="3" y="16.5" width="6" height="5" rx="1" /><rect x="15" y="16.5" width="6" height="5" rx="1" /><path d="M12 7.5v4.5M6 16.5V12h12v4.5" /></>),
  models: <CpuIcon size={20} />,
  tools: svg(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3 17.7 6.3 21l6.3-6.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.3-.6-.6-2.3 2.5-2.7Z" />),
  core: svg(<><path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>),
  webview: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  lock: svg(<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>),
};

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-[var(--radius-full)] border border-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
      {children}
    </span>
  );
}

function CardBody({ card, unknown, lockedLabel, lockedBody }: { card: HubCard; unknown: string; lockedLabel: string; lockedBody: string }) {
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-2)] text-[var(--color-accent)]">
          {card.locked ? HUB_ICONS.lock : card.icon}
        </span>
        {card.locked ? <Chip>{lockedLabel}</Chip> : card.adminChip ? <Chip>Admin</Chip> : null}
      </span>
      <span className="text-[15px] font-semibold text-[var(--color-fg)]">{card.name}</span>
      <span className="text-sm text-[var(--color-muted)]">{card.locked ? card.locked.why : card.desc}</span>
      <span className="text-sm text-[var(--color-muted)]">{card.locked ? lockedBody : card.meta ?? unknown}</span>
    </>
  );
}

/**
 * `/system` — the System hub (Figma 20:2060 / 20:2237). Desktop: a 4-column
 * card grid per group; 768: 2 columns; phone: one list card with whole-row
 * links. Read-only: nothing here mutates, so there are no busy states.
 */
export function SystemHub({
  groups,
  adminNote,
  unknown,
  lockedLabel,
  lockedBody,
  settingsLead,
  settingsLink,
}: {
  groups: HubGroup[];
  adminNote: string | null;
  unknown: string;
  lockedLabel: string;
  lockedBody: string;
  settingsLead: string;
  settingsLink: string;
}) {
  return (
    <div data-component="SystemHub" className="flex flex-col gap-6 pb-24 lg:pb-8">
      {adminNote ? <InlineAlert tone="info">{adminNote}</InlineAlert> : null}
      {groups.map((group) =>
        group.cards.length === 0 ? null : (
          <section key={group.id} aria-labelledby={`hub-${group.id}`} className="flex flex-col gap-2">
            <h2 id={`hub-${group.id}`} className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {group.label}
            </h2>
            {/* Phone: one list card of rows. */}
            <ul className="flex flex-col gap-1 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 md:hidden">
              {group.cards.map((card) => {
                const inner = (
                  <>
                    <span className="shrink-0 text-[var(--color-muted)]">{card.locked ? HUB_ICONS.lock : card.icon}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] font-medium text-[var(--color-fg)]">{card.name}</span>
                      <span className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
                        {card.locked ? `${card.locked.why} ${lockedBody}` : `${card.desc} · ${card.meta ?? unknown}`}
                      </span>
                    </span>
                    {card.locked ? <Chip>{lockedLabel}</Chip> : card.adminChip ? <Chip>Admin</Chip> : null}
                    {card.locked ? null : <ChevronRightIcon size={18} className="shrink-0 text-[var(--color-muted)]" />}
                  </>
                );
                const cls =
                  "flex min-h-11 items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5";
                return (
                  <li key={card.id}>
                    {card.locked ? (
                      <div data-component="HubCard" data-app={card.id} data-locked="true" className={cls}>
                        {inner}
                      </div>
                    ) : (
                      <Link href={card.href} data-component="HubCard" data-app={card.id} className={`${cls} hover:bg-[var(--color-surface-2)]`}>
                        {inner}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* Tablet / desktop: card grid. */}
            <ul className="hidden gap-4 md:grid md:grid-cols-2 lg:grid-cols-4">
              {group.cards.map((card) => {
                const cls =
                  "flex h-full flex-col gap-1.5 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
                const body = <CardBody card={card} unknown={unknown} lockedLabel={lockedLabel} lockedBody={lockedBody} />;
                return (
                  <li key={card.id}>
                    {card.locked ? (
                      <div data-component="HubCard" data-app={card.id} data-locked="true" className={`${cls} opacity-80`}>
                        {body}
                      </div>
                    ) : (
                      <Link
                        href={card.href}
                        data-component="HubCard"
                        data-app={card.id}
                        className={`${cls} hover:border-[var(--color-accent)] focus-visible:border-[var(--color-accent)]`}
                      >
                        {body}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ),
      )}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--color-muted)]">
        <span>{settingsLead}</span>
        <Link href="/settings" className="inline-flex min-h-11 items-center font-medium text-[var(--color-fg)] hover:underline">
          {settingsLink}
        </Link>
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { useProjectAction } from "@/components/projects/useProjectAction";
import { useNeedsYouText } from "@/lib/landing/needsYouText";
import { Spinner } from "@/components/ui/Spinner";
import type { NeedsYouAction, NeedsYouEntry } from "@/types/landing";

import { AlertIcon, BellIcon, CheckIcon } from "@/components/ui/icons";
import { SEVERITY_TONE } from "./tone";

export type PrimaryAction =
  | { kind: "one-tap"; action: NeedsYouAction & { endpoint: string } }
  | { kind: "link"; label: string; href: string };

/** Same-origin BFF paths only: an entry can never make the browser POST elsewhere. */
function isBffPath(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === "string" && /^\/api\/[^/]/.test(endpoint) && !endpoint.includes("..");
}

function withEllipsis(label: string): string {
  return /(…|\.\.\.)$/.test(label) ? label : `${label}…`;
}

/**
 * The one button an entry gets. Only `reversible` entries with a BFF
 * endpoint are one-tap; anything else opens the item (an action that would
 * have posted reads "Approve…", the ellipsis meaning "more on the next page").
 */
export function primaryAction(entry: NeedsYouEntry): PrimaryAction {
  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  const action = actions.find((a) => a.style === "primary") ?? actions[0];
  if (!action) return { kind: "link", label: "Open", href: entry.href };
  if (entry.reversible === true && isBffPath(action.endpoint)) {
    return { kind: "one-tap", action: { ...action, endpoint: action.endpoint } };
  }
  if (action.href) return { kind: "link", label: action.label, href: action.href };
  return { kind: "link", label: withEllipsis(action.label), href: entry.href };
}

const BUTTON =
  "inline-flex min-h-[34px] items-center justify-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 text-[13px] font-medium leading-[18px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-default disabled:opacity-80";

/**
 * One row of the Needs-you panel (Figma `needs-you-item` 3:77): severity
 * icon, title, "source · age" line and the primary action.
 */
export function NeedsYouItem({
  entry,
  now,
  isNew = false,
  onActed,
}: {
  entry: NeedsYouEntry;
  now: number;
  isNew?: boolean;
  /** Called after a one-tap action succeeds, e.g. to re-read the list. */
  onActed?: (entry: NeedsYouEntry) => void;
}) {
  const tone = SEVERITY_TONE[entry.severity] ?? SEVERITY_TONE.fyi;
  const Icon =
    entry.severity === "fyi" ? BellIcon : entry.severity === "review" ? CheckIcon : AlertIcon;
  const text = useNeedsYouText();
  const primary = primaryAction(entry);
  const severityLabel = text.severity(entry.severity);
  const source = [text.detail(entry)?.trim() || null, text.age(entry.created_at, now)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      data-component="NeedsYouItem"
      data-severity={entry.severity}
      data-new={isNew || undefined}
      className={`flex gap-3 rounded-[var(--radius-lg)] border p-3 ${tone.card} ${
        isNew ? "ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-bg)]" : ""
      }`}
    >
      <span className={`mt-px shrink-0 ${tone.icon}`} title={severityLabel}>
        <Icon size={18} />
        <span className="sr-only">{severityLabel}:</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="flex w-full min-w-0 items-start gap-2">
          <Link
            href={entry.href}
            data-testid="needs-you-title"
            className="min-w-0 flex-1 text-[13px] font-medium leading-[18px] text-[var(--color-fg)] [overflow-wrap:anywhere] hover:underline"
          >
            {text.title(entry)}
          </Link>
          {isNew ? (
            <span className="shrink-0 rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold leading-[16px] text-[var(--color-accent-fg)]">
              {text.t("new")}
            </span>
          ) : null}
        </div>
        <p
          data-testid="needs-you-source"
          className="line-clamp-2 w-full text-[12px] font-medium leading-[16px] text-[var(--color-muted)] [overflow-wrap:anywhere]"
        >
          {source}
        </p>
        <div className="pt-1">
          {primary.kind === "one-tap" ? (
            <OneTapButton
              entry={entry}
              action={primary.action}
              className={`${BUTTON} ${tone.button}`}
              onActed={onActed}
            />
          ) : (
            <Link
              href={primary.href}
              data-action="needs-you-open"
              className={`${BUTTON} ${tone.button}`}
            >
              {text.action(primary.label)}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

function OneTapButton({
  entry,
  action,
  className,
  onActed,
}: {
  entry: NeedsYouEntry;
  action: NeedsYouAction & { endpoint: string };
  className: string;
  onActed?: (entry: NeedsYouEntry) => void;
}) {
  // Click lock + Idempotency-Key come from the shared mutation hook. The list
  // re-reads itself instead of a full router refresh.
  const act = useProjectAction<unknown>();
  const text = useNeedsYouText();
  const [done, setDone] = useState(false);

  const fire = async () => {
    const result = await act.run(action.endpoint, {
      method: action.method ?? "POST",
      body: action.body,
      skipRefresh: true,
    });
    if (result?.ok) {
      setDone(true);
      onActed?.(entry);
    }
  };

  const retry = async () => {
    const result = await act.retry();
    if (result?.ok) {
      setDone(true);
      onActed?.(entry);
    }
  };

  if (act.error && !act.busy) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-action="needs-you-retry" onClick={() => void retry()} className={className}>
          {text.t("tryAgain")}
        </button>
        <span role="alert" className="text-[12px] leading-[16px] text-[var(--color-danger)]">
          {act.error}
        </span>
      </div>
    );
  }

  const busy = act.busy;
  return (
    <button
      type="button"
      data-action="needs-you-one-tap"
      data-busy={busy ? "true" : "false"}
      aria-busy={busy}
      disabled={busy || done}
      onClick={() => void fire()}
      className={className}
    >
      {busy ? (
        <>
          <Spinner />
          <span>{text.t("working")}</span>
        </>
      ) : done ? (
        <>
          <CheckIcon size={16} />
          <span>{text.t("done")}</span>
        </>
      ) : (
        text.action(action.label)
      )}
    </button>
  );
}

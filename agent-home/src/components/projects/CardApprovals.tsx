"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { ProjectCardApproval } from "@/types";

export interface ApprovalLink {
  label: string;
  href: string;
}

/** What one approval asks for, in reviewable parts. */
export interface ApprovalView {
  /** The tool the call goes to, when the ask is a tool call. */
  tool: string | null;
  /** Why the worker wants it (MCP tools' `user_intent` argument). */
  intent: string | null;
  /** The call's other arguments, in order. */
  args: [string, string][];
  /** A command or any detail that isn't a tool call's JSON arguments. */
  text: string | null;
  links: ApprovalLink[];
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const CANVA_DESIGN_ID_RE = /^[A-Za-z0-9_-]{6,}$/;

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function argText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * Split an approval's recorded `detail` into what a person reviews: a tool
 * call's detail is `"<tool>\n{json arguments}"` (or the bare arguments), a
 * command's is the command line itself.
 */
export function describeApproval(approval: ProjectCardApproval): ApprovalView {
  const detail = (approval.detail ?? "").trim();
  const newline = detail.indexOf("\n");
  const head = newline === -1 ? detail : detail.slice(0, newline).trim();
  const named = head === approval.key || head === approval.label;
  const parsed = parseObject(named ? detail.slice(head.length).trim() : detail);
  const tool = parsed && (named || approval.key.startsWith("mcp_")) ? approval.key : null;

  let intent: string | null = null;
  const args: [string, string][] = [];
  if (parsed) {
    for (const [name, value] of Object.entries(parsed)) {
      if (name === "user_intent" && typeof value === "string") intent = value;
      else args.push([name, argText(value)]);
    }
  }
  const text = parsed ? null : detail || null;

  const links: ApprovalLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, href: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    links.push({ label, href });
  };
  const designId = parsed?.design_id;
  if (
    tool?.startsWith("mcp_canva_") &&
    typeof designId === "string" &&
    CANVA_DESIGN_ID_RE.test(designId)
  ) {
    add("Open the design in Canva", `https://www.canva.com/design/${encodeURIComponent(designId)}/view`);
  }
  for (const source of [text ?? "", ...args.map(([, v]) => v)]) {
    for (const url of source.match(URL_RE) ?? []) add(url, url);
  }
  return { tool, intent, args, text, links };
}

/** The reviewable body of one approval: why, the exact call, and links. */
export function ApprovalDetail({ approval }: { approval: ProjectCardApproval }) {
  const view = describeApproval(approval);
  return (
    <div data-component="ApprovalDetail" className="mt-1 flex flex-col gap-1.5 text-xs">
      {view.intent ? (
        <p data-component="ApprovalIntent">
          <span className="text-[var(--color-muted)]">Why: </span>
          {view.intent}
        </p>
      ) : null}
      {view.tool ? (
        <p>
          <span className="text-[var(--color-muted)]">Tool: </span>
          <code>{view.tool}</code>
        </p>
      ) : null}
      {view.args.length > 0 ? (
        <dl data-component="ApprovalArgs" className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {view.args.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-[var(--color-muted)]">{name}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.text ? (
        <pre
          data-component="ApprovalCommand"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--color-surface-2)] p-2"
        >
          {view.text}
        </pre>
      ) : null}
      {view.links.length > 0 ? (
        <ul data-component="ApprovalLinks" className="flex flex-col gap-0.5">
          {view.links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-[var(--color-accent)] underline-offset-2 hover:underline"
              >
                {link.label} ↗
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ApprovalRow({
  slug,
  taskId,
  approval,
  canAct,
}: {
  slug: string;
  taskId: string;
  approval: ProjectCardApproval;
  canAct: boolean;
}) {
  const action = useProjectAction();
  const decide = (decision: "approve" | "deny") => {
    if (action.busy) return;
    void action.run(
      `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/approvals`,
      { method: "POST", body: { key: approval.key, decision } },
    );
  };
  return (
    <li
      data-component="CardApproval"
      data-approval-key={approval.key}
      className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-2.5"
    >
      <p className="text-sm font-medium">Waiting on you: allow {approval.label}?</p>
      <ApprovalDetail approval={approval} />
      {canAct ? (
        <div className="mt-2 flex flex-wrap gap-2" data-appmcp-deny="consent">
          <ActionButton
            busy={action.busy}
            pendingLabel="Saving…"
            onClick={() => decide("approve")}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Allow on this card
          </ActionButton>
          <ActionButton
            busy={false}
            disabled={action.busy}
            onClick={() => decide("deny")}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Deny
          </ActionButton>
        </div>
      ) : null}
      <ActionError action={action} className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300" />
    </li>
  );
}

/**
 * The approvals a blocked card's worker is waiting on, each with what it
 * wants to do and an Allow / Deny that answers it for this card. Once
 * nothing is left pending the card is released and runs again.
 */
export function CardApprovals({
  slug,
  taskId,
  approvals,
  canAct,
}: {
  slug: string;
  taskId: string;
  approvals: ProjectCardApproval[];
  canAct: boolean;
}) {
  if (approvals.length === 0) return null;
  return (
    <ul data-component="CardApprovals" className="mt-3 flex flex-col gap-2">
      {approvals.map((approval) => (
        <ApprovalRow
          key={approval.key}
          slug={slug}
          taskId={taskId}
          approval={approval}
          canAct={canAct}
        />
      ))}
    </ul>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/i18n/client";
import type { Tool } from "@/types";

import { IconPicker } from "./IconPicker";
import {
  appApiPath,
  askAgentHref,
  canManageApp,
  displayName,
  openUrl,
  type AppKind,
  type HealthState,
  type Viewer,
} from "./toolsModel";

type Danger = "archive" | "purge" | "delete";

const BTN =
  "flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-sm hover:bg-[var(--color-border)]/40";

/**
 * The per-app action sheet. Members act on their own apps with no approval
 * step (decision 9); archive, purge and delete each take exactly one explicit
 * confirmation, and those buttons carry `data-appmcp-deny` so an app's MCP
 * agent can never press them.
 */
export function ToolActionsSheet({
  tool,
  kind,
  health,
  viewer,
  onClose,
}: {
  tool: Tool;
  kind: AppKind;
  health: HealthState;
  viewer: Viewer | null;
  onClose: () => void;
}) {
  const t = useT("tools");
  const action = useProjectAction();
  const [danger, setDanger] = useState<Danger | null>(null);
  const [picking, setPicking] = useState(false);
  const name = displayName(tool);
  const url = openUrl(tool);
  const manage = canManageApp(viewer, tool);
  const archived = (tool as Tool & { lifecycle_state?: string }).lifecycle_state === "archived";
  const running = health === "running" || health === "dev";
  const isDev = tool.mode === "dev";
  const mode = tool.mode;

  const post = (suffix: string, body: Record<string, unknown> = {}) =>
    void action.run(appApiPath(tool, suffix), { method: "POST", body: { mode, ...body } });

  const confirmDanger = () => {
    if (danger === "delete") {
      const qs = new URLSearchParams({ mode, confirm: tool.name });
      return action.run(`${appApiPath(tool)}?${qs.toString()}`, {
        method: "DELETE",
        onSuccess: () => onClose(),
      });
    }
    return action.run(appApiPath(tool, `/${danger}`), {
      method: "POST",
      body: { mode, confirm: tool.name },
      onSuccess: () => setDanger(null),
    });
  };

  return (
    <div
      data-component="ToolActionsSheet"
      role="dialog"
      aria-modal="true"
      aria-label={t("sheet.title", { name })}
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-[var(--color-surface)] p-4 sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">{name}</h2>
          <button type="button" className="min-h-[44px] min-w-[44px]" aria-label={t("sheet.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          {t(`kind.${kind}`)} · {t(`health.${health}`)}
          {isDev ? ` · ${t("sheet.devCopy")}` : ""}
        </p>
        <ul className="flex flex-col gap-1">
          {url ? (
            <li>
              <a className={BTN} href={url} target="_blank" rel="noopener noreferrer">
                {t("actions.open")}
                {kind === "external" ? " ↗" : ""}
              </a>
            </li>
          ) : null}
          <li>
            <Link className={BTN} href={`/tools/${encodeURIComponent(tool.name)}?mode=${mode}`}>
              {t("actions.details")}
            </Link>
          </li>
          <li>
            <Link className={BTN} href={askAgentHref(tool, t("actions.askPrompt"))}>
              {t("actions.ask")}
            </Link>
          </li>
          {manage && kind === "local" && !archived ? (
            <>
              <li>
                <ActionButton busy={action.busy} className={BTN} onClick={() => post(running ? "/stop" : "/start")}>
                  {running ? t("actions.stop") : t("actions.start")}
                </ActionButton>
              </li>
              {running ? (
                <li>
                  <ActionButton busy={action.busy} className={BTN} onClick={() => post("/restart")}>
                    {t("actions.restart")}
                  </ActionButton>
                </li>
              ) : null}
              {isDev ? (
                <li>
                  <ActionButton busy={action.busy} className={BTN} onClick={() => post("/build")}>
                    {t("actions.build")}
                  </ActionButton>
                </li>
              ) : null}
            </>
          ) : null}
          {manage && kind === "external" && tool.dashboard_url ? (
            <li>
              <a className={BTN} href={tool.dashboard_url} target="_blank" rel="noopener noreferrer">
                {t("actions.console")} ↗
              </a>
            </li>
          ) : null}
          {manage && isDev && !archived ? (
            <li>
              <ActionButton busy={action.busy} className={BTN} onClick={() => post("/promote")}>
                {t("actions.promote")}
              </ActionButton>
            </li>
          ) : null}
          {manage ? (
            <>
              <li>
                <ActionButton
                  busy={action.busy}
                  className={BTN}
                  onClick={() =>
                    void action.run(appApiPath(tool, "/enabled"), {
                      method: "POST",
                      body: { enabled: !tool.enabled, mode },
                    })
                  }
                >
                  {tool.enabled ? t("actions.hide") : t("actions.show")}
                </ActionButton>
              </li>
              <li>
                <ActionButton
                  busy={action.busy}
                  className={BTN}
                  onClick={() =>
                    void action.run(appApiPath(tool, "/visibility"), {
                      method: "PUT",
                      body: { visibility: tool.visibility === "shared" ? "private" : "shared", mode },
                    })
                  }
                >
                  {tool.visibility === "shared" ? t("actions.unshare") : t("actions.share")}
                </ActionButton>
              </li>
              <li>
                <button type="button" className={BTN} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
                  {t("actions.icon")}
                </button>
                {picking ? (
                  <div className="p-2">
                    <IconPicker tool={tool} onDone={() => setPicking(false)} />
                  </div>
                ) : null}
              </li>
              <li data-appmcp-deny="consent" className="mt-2 flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
                {archived ? (
                  <>
                    <ActionButton busy={action.busy} className={BTN} onClick={() => post("/restore")}>
                      {t("actions.restore")}
                    </ActionButton>
                    <button type="button" data-appmcp-deny="consent" className={`${BTN} text-[#c53b3b]`} onClick={() => setDanger("purge")}>
                      {t("actions.purge")}
                    </button>
                  </>
                ) : kind === "local" ? (
                  <button type="button" data-appmcp-deny="consent" className={BTN} onClick={() => setDanger("archive")}>
                    {t("actions.archive")}
                  </button>
                ) : null}
                <button type="button" data-appmcp-deny="consent" className={`${BTN} text-[#c53b3b]`} onClick={() => setDanger("delete")}>
                  {kind === "external" ? t("actions.unlink") : t("actions.delete")}
                </button>
              </li>
            </>
          ) : null}
        </ul>
        {action.error && !danger ? (
          <p role="alert" className="mt-2 text-sm text-[#c53b3b]">
            {action.error}
          </p>
        ) : null}
      </div>
      {danger ? (
        <div data-appmcp-deny="consent">
          <ConfirmDialog
            title={t(`confirm.${danger}.title`, { name })}
            body={action.error ?? t(`confirm.${danger}.body${kind === "external" ? "External" : ""}`, { name })}
            confirmLabel={t(`confirm.${danger}.cta`)}
            cancelLabel={t("confirm.cancel")}
            busy={action.busy}
            onConfirm={confirmDanger}
            onCancel={() => {
              action.clearError();
              setDanger(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

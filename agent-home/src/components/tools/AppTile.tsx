"use client";

import { useState } from "react";

import { useT } from "@/i18n/client";
import type { Tool } from "@/types";

import { AppIcon } from "./AppIcon";
import { ToolActionsSheet } from "./ToolActionsSheet";
import {
  deriveHealth,
  displayName,
  isReady,
  openUrl,
  providerOf,
  type AppHealth,
  type AppKind,
  type Viewer,
} from "./toolsModel";

/**
 * One grid tile. A ready app opens in a new tab; anything else (building,
 * off, failed) opens the actions sheet. Long-press / the "…" button opens
 * the sheet too, so every action stays reachable.
 */
export function AppTile({
  tool,
  kind,
  health: raw,
  viewer,
}: {
  tool: Tool;
  kind: AppKind;
  health?: AppHealth | null;
  viewer: Viewer | null;
}) {
  const t = useT("tools");
  const [open, setOpen] = useState(false);
  const health = deriveHealth(tool, raw);
  const provider = providerOf(tool, raw);
  const name = displayName(tool);
  const url = openUrl(tool);
  const ready = isReady(tool, health);
  const status = t(`health.${health}`);
  const label =
    kind === "external"
      ? t("tile.openExternal", { name, provider: t(`provider.${provider}`), status })
      : t("tile.openLocal", { name, status });
  const body = (
    <>
      <AppIcon tool={tool} kind={kind} provider={provider} health={health} />
      <span className="line-clamp-2 w-full break-words text-center text-xs leading-tight">
        {name}
        {kind === "external" ? (
          <span aria-hidden="true" data-external-arrow className="ml-0.5">
            ↗
          </span>
        ) : null}
      </span>
    </>
  );
  const tileClass =
    "flex min-h-[44px] min-w-[44px] w-full flex-col items-center gap-1.5 rounded-xl p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";
  return (
    <li
      data-component="AppTile"
      data-kind={kind}
      data-health={health}
      className="relative"
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {ready && url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} className={tileClass}>
          {body}
        </a>
      ) : (
        <button type="button" aria-label={label} className={tileClass} onClick={() => setOpen(true)}>
          {body}
        </button>
      )}
      <button
        type="button"
        aria-label={t("tile.actions", { name })}
        onClick={() => setOpen(true)}
        className="absolute left-0 top-0 h-6 w-6 rounded-full text-xs text-[var(--color-muted)] opacity-70 hover:opacity-100"
      >
        …
      </button>
      {open ? (
        <ToolActionsSheet tool={tool} kind={kind} health={health} viewer={viewer} onClose={() => setOpen(false)} />
      ) : null}
    </li>
  );
}

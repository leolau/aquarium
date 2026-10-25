"use client";

import type { Tool } from "@/types";

import { appIconColor, appIconHex } from "./appIconColor";
import { HealthDot } from "./HealthDot";
import { ProviderBadge } from "./ProviderBadge";
import { monogram, type AppKind, type HealthState, type ProviderId } from "./toolsModel";

/**
 * A 64px app icon. Local apps are a SOLID rounded square with a box badge;
 * hosted apps are an OUTLINED circle with a provider badge — the shape, fill
 * and badge differ, so the difference never rests on colour.
 */
export function AppIcon({
  tool,
  kind,
  provider,
  health,
  size = 64,
}: {
  tool: Tool;
  kind: AppKind;
  provider: ProviderId;
  health: HealthState;
  size?: number;
}) {
  const color = appIconHex(appIconColor(tool.name, tool.icon_color));
  const image =
    (tool.icon_source === "uploaded" || tool.icon_source === "favicon") && tool.icon_asset_id
      ? `/api/files/${encodeURIComponent(tool.icon_asset_id)}/content`
      : null;
  const glyph = tool.icon?.trim() || monogram(tool);
  const shape =
    kind === "local"
      ? "rounded-[22%] text-white"
      : "rounded-full border-2 bg-[var(--color-surface)]";
  const style =
    kind === "local" ? { width: size, height: size, background: color } : { width: size, height: size, borderColor: color, color };
  return (
    <span data-component="AppIcon" data-kind={kind} className="relative inline-block" style={{ width: size, height: size }}>
      <span
        data-shape={kind === "local" ? "squircle" : "circle"}
        className={`flex items-center justify-center overflow-hidden text-xl font-semibold ${shape}`}
        style={style}
        aria-hidden="true"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- user asset, already sized
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          glyph
        )}
      </span>
      <ProviderBadge provider={kind === "local" ? "box" : provider} className="absolute -bottom-1 -right-1" />
      <HealthDot state={health} className="absolute -right-0.5 -top-0.5" />
    </span>
  );
}

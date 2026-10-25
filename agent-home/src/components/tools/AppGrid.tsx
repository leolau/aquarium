"use client";

import type { Tool } from "@/types";

import { AppTile } from "./AppTile";
import type { AppHealth, AppKind, Viewer } from "./toolsModel";

/** 4 columns on a 320px phone, 6 from `sm`, 8 from `lg`. */
export function AppGrid({
  tools,
  kind,
  health,
  viewer,
  label,
}: {
  tools: Tool[];
  kind: AppKind;
  health: Map<string, AppHealth>;
  viewer: Viewer | null;
  label: string;
}) {
  return (
    <ul
      data-component="AppGrid"
      data-kind={kind}
      aria-label={label}
      className="grid grid-cols-4 gap-x-2 gap-y-4 sm:grid-cols-6 lg:grid-cols-8"
    >
      {tools.map((tool) => (
        <AppTile key={tool.id} tool={tool} kind={kind} health={health.get(tool.name)} viewer={viewer} />
      ))}
    </ul>
  );
}

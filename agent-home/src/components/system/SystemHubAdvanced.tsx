"use client";

import type { ComponentProps } from "react";

import { AdvancedSwitch, useAdvanced } from "@/components/system/Advanced";
import { SystemHub } from "@/components/system/SystemHub";

/** The System hub with its Advanced switch: engineer-facing cards show only while it is on. */
export function SystemHubAdvanced({
  groups,
  advancedHelp,
  ...rest
}: ComponentProps<typeof SystemHub> & { advancedHelp: string }) {
  const [advanced, setAdvanced] = useAdvanced("system");
  const shown = advanced ? groups : groups.map((g) => ({ ...g, cards: g.cards.filter((c) => !c.advanced) }));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <AdvancedSwitch on={advanced} onChange={setAdvanced} help={advancedHelp} />
      </div>
      <SystemHub groups={shown} {...rest} />
    </div>
  );
}

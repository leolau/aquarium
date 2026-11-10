"use client";

import type { Ref } from "react";

import { useT } from "@/i18n/client";
import { CREATURES, type AquariumUser } from "@/lib/aquarium/creatures";

import { CreatureIcon } from "./CreatureIcon";
import { followerCreature, formatCount } from "./mapping";

export interface CreatureCardProps {
  user: AquariumUser;
  /** The follower under the pointer, when it is one of the person's profiles. */
  profile?: string;
  ref?: Ref<HTMLDivElement>;
}

/** The hover/tap card; positioned by the render loop through `ref`. */
export function CreatureCard({ user, profile, ref }: CreatureCardProps) {
  const t = useT("aquarium");
  const m = user.metrics;
  const follower = profile ? user.profiles.find((p) => p.name === profile) : undefined;
  const creatureLabel = CREATURES.find((c) => c.id === user.creature)?.label ?? user.creature;
  return (
    <div
      ref={ref}
      data-component="CreatureCard"
      role="status"
      className="pointer-events-none absolute left-0 top-0 z-20 w-56 rounded-2xl bg-[rgb(3_24_52/0.88)] p-3 text-xs text-white shadow-xl ring-1 ring-white/15 backdrop-blur-sm"
      style={{ opacity: 0 }}
    >
      {follower && (
        <div className="mb-2 flex items-center gap-2 border-b border-white/15 pb-2">
          <CreatureIcon id={followerCreature(user.user_id, follower.name, user.creature)} size={28} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{follower.display_name}</div>
            <div className="text-white/70">{t("card.profileOf", { name: user.name })}</div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <CreatureIcon id={user.creature} size={36} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {user.name}
            {user.is_self && <span className="ml-1 text-[#ffd84a]">{t("card.you")}</span>}
          </div>
          <div className="text-white/70">
            {creatureLabel}
            {m.active_now && <span className="ml-1 text-[#8cffec]">· {t("card.activeNow")}</span>}
          </div>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-1 text-center">
        <div>
          <dt className="text-white/60">{t("card.chats")}</dt>
          <dd className="font-semibold">{formatCount(m.chats)}</dd>
        </div>
        <div>
          <dt className="text-white/60">{t("card.projects")}</dt>
          <dd className="font-semibold">{formatCount(m.projects)}</dd>
        </div>
        <div>
          <dt className="text-white/60">{t("card.tokens")}</dt>
          <dd className="font-semibold">{formatCount(m.tokens_in + m.tokens_out)}</dd>
        </div>
      </dl>
      <div className="mt-2 text-white/60">{t("card.profiles")}</div>
      <div className="truncate">
        {user.profiles.length > 0 ? user.profiles.map((p) => p.display_name).join(", ") : t("card.noProfiles")}
      </div>
    </div>
  );
}

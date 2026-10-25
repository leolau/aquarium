"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useT } from "@/i18n/client";
import type { Tool } from "@/types";

import { APP_ICON_COLORS, appIconColor, appIconHex, type AppIconColor } from "./appIconColor";
import { appApiPath, monogram } from "./toolsModel";

/** Pick a monogram/emoji + palette colour, or fall back to the app's favicon. */
export function IconPicker({ tool, onDone }: { tool: Tool; onDone?: () => void }) {
  const t = useT("tools");
  const action = useProjectAction();
  const [glyph, setGlyph] = useState(tool.icon ?? monogram(tool));
  const [color, setColor] = useState<AppIconColor>(appIconColor(tool.name, tool.icon_color));
  const valid = [...glyph.trim()].length >= 1 && [...glyph.trim()].length <= 2;
  return (
    <div data-component="IconPicker" className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t("icon.glyph")}
        <input
          value={glyph}
          maxLength={8}
          onChange={(e) => setGlyph(e.target.value)}
          className="min-h-[44px] rounded-xl border border-[var(--color-border)] bg-transparent px-3"
        />
      </label>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-sm">{t("icon.color")}</legend>
        {APP_ICON_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === color}
            aria-label={t(`color.${c}`)}
            onClick={() => setColor(c)}
            className={`h-11 w-11 rounded-full border-2 ${c === color ? "border-[var(--color-fg)]" : "border-transparent"}`}
            style={{ background: appIconHex(c) }}
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <ActionButton
          busy={action.busy}
          disabled={!valid}
          pendingLabel={t("actions.saving")}
          className="min-h-[44px] rounded-xl bg-[var(--color-accent)] px-4 text-sm text-white"
          onClick={() =>
            void action.run(appApiPath(tool, "/icon"), {
              method: "PUT",
              body: { icon_source: "generated", icon: glyph.trim(), icon_color: color, mode: tool.mode },
              onSuccess: () => onDone?.(),
            })
          }
        >
          {t("icon.save")}
        </ActionButton>
        <ActionButton
          busy={action.busy}
          pendingLabel={t("actions.saving")}
          className="min-h-[44px] rounded-xl border border-[var(--color-border)] px-4 text-sm"
          onClick={() =>
            void action.run(appApiPath(tool, "/favicon"), {
              method: "POST",
              body: { mode: tool.mode },
              onSuccess: () => onDone?.(),
            })
          }
        >
          {t("icon.useFavicon")}
        </ActionButton>
      </div>
      {action.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger,#c53b3b)]">
          {action.error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import { InfoTip } from "@/components/ui/InfoTip";
import { useT } from "@/i18n/client";

const storageKey = (scope: string) => `aquarium.advanced.${scope}`;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readSaved(scope: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(scope));
  } catch {
    return null;
  }
}

/** Whether the engineer-facing detail on `scope` is shown; off by default, remembered on this device. */
export function useAdvanced(scope: string, initial = false): [boolean, (next: boolean) => void] {
  const [session, setSession] = useState<boolean | null>(null);
  const saved = useSyncExternalStore(
    subscribe,
    () => readSaved(scope),
    () => null,
  );
  const on = session ?? (saved === null ? initial : saved === "1");
  const set = useCallback(
    (next: boolean) => {
      setSession(next);
      try {
        window.localStorage.setItem(storageKey(scope), next ? "1" : "0");
      } catch {
        /* storage blocked: the choice lasts for this visit */
      }
      listeners.forEach((l) => l());
    },
    [scope],
  );
  return [on, set];
}

/** The "Advanced" switch every System page shows to everyone (with a tap-open tip). */
export function AdvancedSwitch({ on, onChange, help }: { on: boolean; onChange: (next: boolean) => void; help?: string }) {
  const t = useT("system");
  return (
    <span data-component="AdvancedSwitch" className="inline-flex items-center gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-action="toggle-advanced"
        onClick={() => onChange(!on)}
        className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] px-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] lg:min-h-8"
      >
        <span
          aria-hidden
          className={`relative block h-5 w-9 rounded-[var(--radius-full)] transition-colors ${
            on ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-[var(--radius-full)] bg-[var(--color-fg)] transition-all ${
              on ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </span>
        {t("advanced")}
      </button>
      <InfoTip label={t("advancedInfo")} align="end">
        {help ?? t("advancedHelp")}
      </InfoTip>
    </span>
  );
}

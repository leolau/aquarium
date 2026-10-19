"use client";

import { useSyncExternalStore } from "react";

import en from "@/i18n/messages/en/extraTools.json";
import zhHant from "@/i18n/messages/zh-Hant/extraTools.json";

/**
 * Tiny local stand-in for the shared `useT('extraTools')` hook (not on
 * develop yet): same message files, picks 繁中 when the page or browser
 * language is Chinese. Swap for `useT` once `agent-home/src/i18n` lands.
 */
export type ExtraToolsKey = keyof typeof en;
type Vars = Record<string, string | number>;

const MESSAGES: Record<"en" | "zh-Hant", Record<ExtraToolsKey, string>> = {
  en,
  "zh-Hant": zhHant,
};

function detect(): "en" | "zh-Hant" {
  if (typeof document === "undefined") return "en";
  const tags = [document.documentElement.lang, ...(navigator.languages ?? [])];
  return tags.some((t) => /^zh/i.test(t ?? "")) ? "zh-Hant" : "en";
}

export function format(template: string, vars?: Vars): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars && k in vars ? String(vars[k]) : `{${k}}`,
  );
}

const noSubscribe = () => () => {};

export function useExtraToolsT(): (key: ExtraToolsKey, vars?: Vars) => string {
  const lang = useSyncExternalStore(noSubscribe, detect, () => "en" as const);
  return (key, vars) => format(MESSAGES[lang][key] ?? MESSAGES.en[key], vars);
}

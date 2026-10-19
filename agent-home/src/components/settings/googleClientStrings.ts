"use client";

import { useSyncExternalStore } from "react";

import en from "@/i18n/messages/en/googleClient.json";
import zhHant from "@/i18n/messages/zh-Hant/googleClient.json";

export type GoogleClientKey = keyof typeof en;
type Vars = Record<string, string | number>;
export type GoogleClientT = (key: GoogleClientKey, vars?: Vars) => string;

const MESSAGES: Record<"en" | "zh-Hant", Record<GoogleClientKey, string>> = {
  en,
  "zh-Hant": zhHant,
};

export function pickLocale(languages: readonly string[]): "en" | "zh-Hant" {
  return languages.some((l) => l.toLowerCase().startsWith("zh")) ? "zh-Hant" : "en";
}

export function translate(
  locale: "en" | "zh-Hant",
  key: GoogleClientKey,
  vars?: Vars,
): string {
  const text = MESSAGES[locale][key] ?? en[key] ?? key;
  return vars
    ? text.replace(/\{(\w+)\}/g, (m, name: string) =>
        name in vars ? String(vars[name]) : m,
      )
    : text;
}

function subscribeLanguage(onChange: () => void): () => void {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

/**
 * Stand-in for the shared `useT("googleClient")` hook until the i18n unit
 * lands: same JSON files, browser language picks English or 繁體中文.
 */
export function useGoogleClientT(): GoogleClientT {
  const locale = useSyncExternalStore(
    subscribeLanguage,
    () => pickLocale(navigator.languages ?? [navigator.language]),
    () => "en" as const,
  );
  return (key, vars) => translate(locale, key, vars);
}

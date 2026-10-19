"use client";

/**
 * Local stand-in for the shared `useT` hook (built by the i18n unit): reads
 * this feature's strings from `src/i18n/messages/<locale>/getReady.json`.
 * Swap the import to `@/i18n` once that hook lands; the call sites stay.
 */
import { useCallback, useSyncExternalStore } from "react";

import en from "@/i18n/messages/en/getReady.json";
import zhHant from "@/i18n/messages/zh-Hant/getReady.json";

export type Locale = "en" | "zh-Hant";
export type Params = Record<string, string | number>;

const MESSAGES: Record<Locale, Record<string, string>> = { en, "zh-Hant": zhHant };

export const LOCALE_STORAGE_KEY = "aquarium.locale";

export function pickLocale(value: string | null | undefined): Locale {
  return value && value.toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function translate(locale: Locale, key: string, params?: Params): string {
  const message = MESSAGES[locale][key] ?? MESSAGES.en[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : match,
  );
}

function readLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return pickLocale(stored ?? document.documentElement.lang);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, readLocale, () => "en");
}

export type T = (key: string, params?: Params) => string;

export function useT(namespace: "getReady"): T {
  void namespace;
  const locale = useLocale();
  return useCallback((key: string, params?: Params) => translate(locale, key, params), [locale]);
}

export function formatWhen(locale: Locale, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-Hant-HK" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

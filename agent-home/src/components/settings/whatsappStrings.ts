/**
 * Strings for the WhatsApp setup block, read from the shared
 * i18n/messages/<lang>/whatsapp.json files. Tiny local stand-in until the
 * shared `useT` hook lands; it follows the page's `<html lang>`.
 */
import { useEffect, useState } from "react";

import en from "@/i18n/messages/en/whatsapp.json";
import zhHant from "@/i18n/messages/zh-Hant/whatsapp.json";

export type WhatsAppKey = keyof typeof en;
type Lang = "en" | "zh-Hant";

const MESSAGES: Record<Lang, Record<string, string>> = { en, "zh-Hant": zhHant };

export function pickLang(htmlLang: string | null | undefined): Lang {
  return (htmlLang ?? "").toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function translate(
  lang: Lang,
  key: WhatsAppKey,
  vars?: Record<string, string | number>,
): string {
  const text = MESSAGES[lang][key] ?? en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_m, v: string) =>
    vars && v in vars ? String(vars[v]) : `{${v}}`,
  );
}

export function useWhatsAppT() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const t = setTimeout(() => setLang(pickLang(document.documentElement.lang)), 0);
    return () => clearTimeout(t);
  }, []);
  return (key: WhatsAppKey, vars?: Record<string, string | number>) =>
    translate(lang, key, vars);
}

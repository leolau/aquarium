/**
 * Strings for the Telegram block (namespace `telegramBot`). A tiny local
 * helper until the shared `useT()` hook lands in `@/i18n`: it reads the same
 * JSON files and picks zh-Hant when the browser language is Chinese.
 */
import en from "@/i18n/messages/en/telegramBot.json";
import zhHant from "@/i18n/messages/zh-Hant/telegramBot.json";

export type TelegramBotKey = keyof typeof en;
export const TELEGRAM_BOT_MESSAGES = { en, "zh-Hant": zhHant } as const;

export function pickLocale(lang: string | undefined | null): keyof typeof TELEGRAM_BOT_MESSAGES {
  return (lang ?? "").toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function translate(
  locale: keyof typeof TELEGRAM_BOT_MESSAGES,
  key: TelegramBotKey,
  vars: Record<string, string> = {},
): string {
  const text: string = TELEGRAM_BOT_MESSAGES[locale][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
}

/** Plain-language message for an error code Hermes returned. */
export function errorKey(detail: string | undefined | null): TelegramBotKey {
  const text = detail ?? "";
  const codes = (Object.keys(en) as TelegramBotKey[])
    .filter((k) => k.startsWith("err_") && k !== "err_generic")
    .sort((a, b) => b.length - a.length);
  return codes.find((k) => text.includes(k.slice(4))) ?? "err_generic";
}

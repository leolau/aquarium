"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { createTranslator, type Messages, type Translator } from "@/i18n/translate";

/** Strings used when no provider is mounted (unit tests seed English here). */
let fallbackMessages: Messages = {};
export function setFallbackMessages(messages: Messages): void {
  fallbackMessages = messages;
}

const I18nContext = createContext<{ locale: Locale; messages: Messages } | null>(null);

/** Mounted once by the root layout with the request's language and strings. */
export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const t = useT("login"); t("signIn")` — strings from messages/<locale>/login.json. */
export function useT(namespace: string): Translator {
  const messages = useContext(I18nContext)?.messages ?? fallbackMessages;
  return useMemo(() => createTranslator(messages, namespace), [messages, namespace]);
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? DEFAULT_LOCALE;
}

import "server-only";

import { cookies } from "next/headers";

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { loadMessages } from "@/i18n/load";
import { createTranslator, type Translator } from "@/i18n/translate";

export { loadMessages } from "@/i18n/load";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The language this request renders in (browser copy; English by default). */
export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Remember `locale` in this browser (route handlers / server actions only). */
export async function setLocaleCookie(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}

/** Server-component equivalent of `useT`: `const t = await getT("login")`. */
export async function getT(namespace: string): Promise<Translator> {
  return createTranslator(loadMessages(await getLocale()), namespace);
}

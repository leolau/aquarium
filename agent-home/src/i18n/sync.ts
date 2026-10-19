import "server-only";

import { isLocale, type Locale } from "@/i18n/config";
import { getLocale, setLocaleCookie } from "@/i18n/server";

/** What `syncLanguageAtLogin` needs from the API client (kept narrow for tests). */
export interface PreferencesApi {
  myPreferences(): Promise<{ language: string | null }>;
  setMyLanguage(language: string): Promise<{ language: string }>;
}

/**
 * At sign-in, the person's saved language wins and is copied to this browser.
 * Someone who never chose one keeps what they picked on the login page, and
 * that choice is saved for them. Best effort: a failure keeps the browser copy.
 */
export async function syncLanguageAtLogin(api: PreferencesApi): Promise<Locale | null> {
  try {
    const { language } = await api.myPreferences();
    if (isLocale(language)) {
      await setLocaleCookie(language);
      return language;
    }
    const chosen = await getLocale();
    await api.setMyLanguage(chosen);
    return chosen;
  } catch {
    return null;
  }
}

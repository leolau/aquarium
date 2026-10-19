# agent-home i18n

Languages: `en` (default) and `zh-Hant` (Traditional Chinese as used in Hong Kong; `<html lang="zh-Hant-HK">`).

## Adding strings for a feature

1. Pick a namespace (e.g. `getReady`) and add both files:
   - `messages/en/getReady.json`
   - `messages/zh-Hant/getReady.json`
   Nothing else to register — every JSON file in the folder is loaded.
2. Read them:
   - Client component: `const t = useT("getReady")` from `@/i18n`.
   - Server component / route: `const t = await getT("getReady")` from `@/i18n/server`.
3. `t("title")`, nested keys with dots (`t("items.google.name")`), placeholders
   with `{name}`: `t("stepsDone", { done: 2, total: 6 })`. `t.has(key)` checks a key.

`messages.test.ts` fails if a key in `en` is missing from `zh-Hant` (or a
placeholder differs). A missing `zh-Hant` string falls back to English at
runtime; a key missing everywhere renders as `namespace.key`.

## How the language is chosen

- Browser cookie `aq_lang` decides what a page renders in (English if unset).
- `LanguageSwitch` posts to `/api/session/language`: it sets the cookie and,
  when signed in, saves the choice for that person
  (`PUT /api/me/preferences` → `$HERMES_HOME/auth/user_prefs/`).
- At sign-in the person's saved language is copied to the cookie; if they
  never chose one, the language picked on the login page is saved for them.

Strings ship with the app and are read from disk on the server; nothing is
fetched over the network.

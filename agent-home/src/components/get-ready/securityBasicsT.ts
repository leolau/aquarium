"use client";

/** React hook over securityBasicsStrings.ts; the language follows <html lang>. */
import { useCallback, useSyncExternalStore } from "react";

import { type Lang, pickLang, translate, type Translate } from "./securityBasicsStrings";

export type { Lang, SecurityBasicsKey, Translate } from "./securityBasicsStrings";
export { pickLang, translate } from "./securityBasicsStrings";

const noSubscribe = () => () => {};

export function useSecurityBasicsT(lang?: Lang): { t: Translate; lang: Lang } {
  const fromPage = useSyncExternalStore(
    noSubscribe,
    () => pickLang(document.documentElement.lang),
    () => "en" as Lang,
  );
  const current = lang ?? fromPage;
  const t = useCallback<Translate>((key, vars) => translate(current, key, vars), [current]);
  return { t, lang: current };
}

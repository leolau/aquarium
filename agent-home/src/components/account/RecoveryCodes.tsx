"use client";

import { useState } from "react";

import { secondary } from "./ui";
import type { AccountT } from "./useAccountT";

/** The ten one-time codes, shown once, with Download and Copy. */
export function RecoveryCodes({ codes, t }: { codes: string[]; t: AccountT }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n") + "\n";

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "aquarium-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div data-component="RecoveryCodes" className="flex flex-col gap-2">
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <p className="text-xs text-[var(--color-muted)]">{t("codesOnce")}</p>
      <div className="flex gap-2">
        <button type="button" onClick={download} className={secondary}>
          {t("download")}
        </button>
        <button type="button" onClick={copy} className={secondary}>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
    </div>
  );
}

import { sendJson } from "@/components/users/api";
import type { AccountSecurity, TwoFactorResult } from "@/lib/api/client";

export type { AccountSecurity };

export async function loadSecurity(): Promise<AccountSecurity> {
  const res = await fetch("/api/account/security", { cache: "no-store" });
  if (!res.ok) throw new Error("load failed");
  return (await res.json()) as AccountSecurity;
}

export function twoFactor(
  action: "start" | "confirm" | "disable" | "recovery-codes",
  body: { password?: string; code?: string },
): Promise<TwoFactorResult> {
  return sendJson<TwoFactorResult>(`/api/account/two-factor/${action}`, "POST", body);
}

export function changePassword(body: {
  current_password: string;
  new_password: string;
  code?: string;
}): Promise<{ ok: boolean }> {
  return sendJson("/api/account/password", "POST", body);
}

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP" (easier to type into an app). */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

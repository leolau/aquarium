/**
 * Which password provider(s) a login tries, so the sign-in form never asks.
 * An identifier with an `@` prefers an email provider, anything else prefers a
 * username provider; at most one other password provider is the fallback.
 */
export interface PasswordProviderInfo {
  name: string;
  display_name?: string;
  supports_password: boolean;
}

const USERNAME_PROVIDERS = new Set(["basic"]);

function takesUsernames(p: PasswordProviderInfo): boolean {
  if (USERNAME_PROVIDERS.has(p.name)) return true;
  const label = p.display_name ?? "";
  return /username/i.test(label) && !/e-?mail/i.test(label);
}

/** Up to two provider names, best first, for this identifier. */
export function passwordProviderOrder(identifier: string, providers: PasswordProviderInfo[]): string[] {
  const usable = providers.filter((p) => p.supports_password);
  const wantsUsername = !identifier.includes("@");
  const preferred = usable.filter((p) => takesUsernames(p) === wantsUsername);
  const others = usable.filter((p) => takesUsernames(p) !== wantsUsername);
  return [...preferred, ...others].slice(0, 2).map((p) => p.name);
}

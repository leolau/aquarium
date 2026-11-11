/**
 * Spot secret-looking text typed or pasted into the normal chat composer
 * (FG-37), so the person can move it into the masked secret popup instead of
 * sending it as chat text. Pure and synchronous: it runs on every keystroke.
 *
 * Heuristic on purpose. A miss only skips a warning (the person can still use
 * the lock button); a false alarm only shows a dismissable warning.
 */

export type SecretMatchKind =
  | "github"
  | "api_key"
  | "aws"
  | "slack"
  | "google"
  | "jwt"
  | "private_key"
  | "password"
  | "token";

export interface SecretMatch {
  kind: SecretMatchKind;
  /** The secret itself (for `password: x`, just `x`). */
  value: string;
  /** Range to remove from the composer text (`[start, end)`). */
  start: number;
  end: number;
}

const PATTERNS: { kind: SecretMatchKind; rx: RegExp }[] = [
  { kind: "private_key", rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/ },
  { kind: "github", rx: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { kind: "api_key", rx: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: "aws", rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "slack", rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "google", rx: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "jwt", rx: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

/** `password: hunter22`, `pwd=…`, `api key: …`, `密碼：…` — the value is group 1. */
const ASSIGNMENT =
  /(?:\b(?:password|passwd|pwd|passcode|passphrase|api[ _-]?key|access[ _-]?token|secret|token)\b|密碼|密码)\s*(?:is\s*)?[:=：]\s*["'`]?([^\s"'`]{6,})["'`]?/i;

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long random-looking token: 32+ token characters mixing upper case, lower
 * case and digits with high entropy. Hex-only strings (commit SHAs, UUIDs),
 * URLs and paths are left alone.
 */
export function looksLikeRandomToken(word: string): boolean {
  if (word.length < 32 || word.length > 4096) return false;
  if (!/^[A-Za-z0-9+/=_.-]+$/.test(word)) return false;
  if (word.includes("://") || /^[./~]/.test(word) || word.includes("/") && word.includes(".")) {
    return false;
  }
  if (!/[A-Z]/.test(word) || !/[a-z]/.test(word) || !/[0-9]/.test(word)) return false;
  return entropy(word) >= 4.2;
}

/** The first secret-looking span in `text`, or null. */
export function detectSecret(text: string): SecretMatch | null {
  if (!text) return null;
  let best: SecretMatch | null = null;
  const consider = (m: SecretMatch) => {
    if (!best || m.start < best.start) best = m;
  };
  for (const { kind, rx } of PATTERNS) {
    const m = rx.exec(text);
    if (m) consider({ kind, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  const a = ASSIGNMENT.exec(text);
  if (a && a[1]) {
    // A known token after `token:` is reported as that token, not as a password.
    const inner = a.index + a[0].indexOf(a[1]);
    if (!best || (best as SecretMatch).start > inner || (best as SecretMatch).end <= inner) {
      consider({ kind: "password", value: a[1], start: a.index, end: a.index + a[0].length });
    }
  }
  if (!best) {
    const word = /\S+/g;
    for (let m = word.exec(text); m; m = word.exec(text)) {
      const raw = m[0].replace(/^["'`(<[]+|["'`)>\],.;:!?]+$/g, "");
      if (looksLikeRandomToken(raw)) {
        const start = m.index + m[0].indexOf(raw);
        return { kind: "token", value: raw, start, end: start + raw.length };
      }
    }
  }
  return best;
}

/** `text` with the match removed (and the gap it leaves tidied). */
export function removeSecret(text: string, match: SecretMatch): string {
  const before = text.slice(0, match.start).replace(/[ \t]+$/, "");
  const after = text.slice(match.end).replace(/^[ \t]+/, "");
  if (!before) return after;
  if (!after) return before;
  return /\s$/.test(before) || /^\s/.test(after) ? before + after : `${before} ${after}`;
}

/** A starting name for the secure box, by what was detected. */
export function suggestedSecretName(kind: SecretMatchKind): string {
  switch (kind) {
    case "github":
      return "github-pat";
    case "api_key":
      return "api-key";
    case "aws":
      return "aws-access-key";
    case "slack":
      return "slack-token";
    case "google":
      return "google-api-key";
    case "jwt":
      return "jwt";
    case "private_key":
      return "private-key";
    case "password":
      return "password";
    default:
      return "secret";
  }
}

import { describe, expect, it } from "vitest";

import {
  detectSecret,
  entropy,
  looksLikeRandomToken,
  removeSecret,
  suggestedSecretName,
} from "@/lib/chat/secret-detect";

// Built at runtime so no literal looks like a real credential to scanners.
const rand = (n: number, alphabet = "aB3xK9mQ2pZ7wR5tY8uL4nV6cJ1hG0fD") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

describe("detectSecret", () => {
  it.each([
    ["github", `here is my token ghp_${rand(36)} thanks`, `ghp_${rand(36)}`],
    ["github", `github_pat_${rand(22)}_${rand(59)}`, `github_pat_${rand(22)}_${rand(59)}`],
    ["api_key", `key sk-proj-${rand(40)}`, `sk-proj-${rand(40)}`],
    ["aws", "aws AKIAIOSFODNN7EXAMPLE ok", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rand(43)}`, `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rand(43)}`],
    ["slack", `xoxb-${rand(24)}`, `xoxb-${rand(24)}`],
  ])("finds a %s", (kind, text, value) => {
    const m = detectSecret(text);
    expect(m?.kind).toBe(kind);
    expect(m?.value).toBe(value);
    expect(text.slice(m!.start, m!.end)).toBe(value);
  });

  it("finds a password assignment and its value", () => {
    const text = "log in with password: Hunter2!x then deploy";
    const m = detectSecret(text);
    expect(m?.kind).toBe("password");
    expect(m?.value).toBe("Hunter2!x");
    expect(text.slice(m!.start, m!.end)).toBe("password: Hunter2!x");
  });

  it.each(["pwd=Secr3tPass", "API key = abcdef123456", "密碼：abc12345"])(
    "finds the assignment form %s",
    (text) => {
      expect(detectSecret(text)?.kind).toBe("password");
    },
  );

  it("leaves the composer's own [secret: name] reference alone", () => {
    expect(detectSecret("[secret: npm-token]")).toBeNull();
    expect(detectSecret("use [secret: github-pat] to push")).toBeNull();
    expect(detectSecret("[secret: npm-token] secret: Hunter2!x")?.value).toBe("Hunter2!x");
  });

  it("reports a known token after `token:` as that token", () => {
    const m = detectSecret(`token: ghp_${rand(36)}`);
    expect(m?.kind).toBe("github");
  });

  it("finds a private key block", () => {
    const text = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    expect(detectSecret(text)?.kind).toBe("private_key");
  });

  it("finds a long high-entropy token", () => {
    const token = rand(40);
    const m = detectSecret(`use ${token}.`);
    expect(m?.kind).toBe("token");
    expect(m?.value).toBe(token);
  });

  it.each([
    "",
    "Can you fix the login page? The password field is broken.",
    "Commit 3f786850e387550fdab836ed7e6dc881de23001b broke it",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "see https://example.com/a/VeryLongPathSegmentWith123Numbers/AndMoreAbc456",
    "src/components/chat/SecretRequestModalAndMoreName123.tsx",
    "The token: it expires soon",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(detectSecret(text)).toBeNull();
  });
});

describe("helpers", () => {
  it("entropy grows with variety", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });

  it("looksLikeRandomToken needs length and mixed classes", () => {
    expect(looksLikeRandomToken(rand(40))).toBe(true);
    expect(looksLikeRandomToken(rand(20))).toBe(false);
    expect(looksLikeRandomToken(rand(40).toLowerCase())).toBe(false);
  });

  it("removeSecret takes out the span and tidies spaces", () => {
    const text = `push with ghp_${rand(36)} please`;
    expect(removeSecret(text, detectSecret(text)!)).toBe("push with please");
    const only = `ghp_${rand(36)}`;
    expect(removeSecret(only, detectSecret(only)!)).toBe("");
  });

  it("suggests a valid name per kind", () => {
    for (const kind of ["github", "api_key", "aws", "jwt", "password", "token"] as const) {
      expect(suggestedSecretName(kind)).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    }
  });
});

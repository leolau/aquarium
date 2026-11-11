import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answerSecretRequest,
  errorCodeForStatus,
  formatCountdown,
  insertSecretRef,
  isSecretName,
  saveVolunteeredSecret,
  secondsLeft,
  SecretSubmitError,
  slugifySecretName,
} from "@/lib/chat/secret-prompt";

afterEach(() => vi.unstubAllGlobals());

describe("secret names", () => {
  it("follows the store's name rule", () => {
    expect(isSecretName("github-pat")).toBe(true);
    expect(isSecretName("a.b_c-1")).toBe(true);
    expect(isSecretName("-bad")).toBe(false);
    expect(isSecretName("Bad")).toBe(false);
    expect(isSecretName("x".repeat(65))).toBe(false);
  });

  it("slugifies typed names", () => {
    expect(slugifySecretName("My GitHub PAT")).toBe("my-github-pat");
    expect(slugifySecretName("--x")).toBe("x");
    expect(slugifySecretName("x".repeat(80))).toHaveLength(64);
  });
});

describe("insertSecretRef", () => {
  it("inserts a spaced reference at the position", () => {
    expect(insertSecretRef("push with please", 10, "github-pat")).toBe(
      "push with [secret: github-pat] please",
    );
    expect(insertSecretRef("use", 99, "k")).toBe("use [secret: k]");
    expect(insertSecretRef("", 0, "k")).toBe("[secret: k]");
  });
});

describe("countdown", () => {
  it("counts whole seconds down to zero", () => {
    expect(secondsLeft(null, 0)).toBeNull();
    expect(secondsLeft(100, 40_500)).toBe(59);
    expect(secondsLeft(100, 200_000)).toBe(0);
    expect(formatCountdown(605)).toBe("10:05");
  });
});

describe("network calls", () => {
  it("maps statuses to codes", () => {
    expect(errorCodeForStatus(404)).toBe("gone");
    expect(errorCodeForStatus(403)).toBe("forbidden");
    expect(errorCodeForStatus(409)).toBe("answered");
    expect(errorCodeForStatus(422)).toBe("invalid");
    expect(errorCodeForStatus(500)).toBe("failed");
  });

  it("posts an answer to the BFF with the profile", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await answerSecretRequest({ requestId: "sr_1", values: { value: "v" }, profile: "work" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat/secret");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({
      request_id: "sr_1",
      values: { value: "v" },
      profile: "work",
    });
  });

  it("posts a decline without values", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await answerSecretRequest({ requestId: "sr_1", decline: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ request_id: "sr_1", decline: true });
  });

  it("throws a code-only error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"detail":"secret-value"}', { status: 409 })));
    const err = await answerSecretRequest({ requestId: "sr_1", values: { value: "secret-value" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretSubmitError);
    expect((err as SecretSubmitError).code).toBe("answered");
    expect(String((err as Error).message)).not.toContain("secret-value");
  });

  it("saves a volunteered secret through the credentials BFF", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await saveVolunteeredSecret("github-pat", "v");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/credentials/secret/github-pat");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "secret",
      payload: { value: "v" },
      visibility: "private",
    });
  });
});

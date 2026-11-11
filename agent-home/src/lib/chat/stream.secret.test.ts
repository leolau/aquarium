/** FG-37: the chat stream surfaces `secret.request` frames as typed requests. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSecretRequest, streamChatTurn } from "@/lib/chat/stream";
import type { ChatSecretRequest } from "@/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSecretRequest", () => {
  it("reads a secret request payload", () => {
    expect(
      parseSecretRequest({
        event: "secret.request",
        request_id: "sr_0123456789abcdef",
        message_id: "msg_1",
        name: "github-pat",
        label: "GitHub personal access token",
        purpose: "Push the fix to leolau/aquarium",
        kind: "secret",
        username: null,
        expires_at: 1794380000.0,
      }),
    ).toEqual({
      requestId: "sr_0123456789abcdef",
      messageId: "msg_1",
      name: "github-pat",
      label: "GitHub personal access token",
      purpose: "Push the fix to leolau/aquarium",
      kind: "secret",
      username: null,
      expiresAt: 1794380000.0,
    });
  });

  it("keeps the username prefill of a password request", () => {
    const req = parseSecretRequest({
      request_id: "sr_1",
      name: "erp-login",
      kind: "password",
      username: "mia",
    });
    expect(req?.kind).toBe("password");
    expect(req?.username).toBe("mia");
    expect(req?.label).toBe("erp-login");
    expect(req?.expiresAt).toBeNull();
  });

  it("treats unknown kinds as a single secret", () => {
    expect(parseSecretRequest({ request_id: "sr_1", name: "x", kind: "weird" })?.kind).toBe(
      "secret",
    );
  });

  it("drops frames without a request id or a name", () => {
    expect(parseSecretRequest({ name: "github-pat" })).toBeNull();
    expect(parseSecretRequest({ request_id: "sr_1" })).toBeNull();
    expect(parseSecretRequest({ request_id: "sr_1", name: "  " })).toBeNull();
  });
});

describe("streamChatTurn secret.request", () => {
  it("dispatches onSecretRequest mid-turn", async () => {
    const body =
      [
        'event: run.accepted\ndata: {"run_id":"run_1","session_id":"sess_1"}',
        'event: secret.request\ndata: {"request_id":"sr_0123456789abcdef","name":"github-pat","label":"GitHub PAT","purpose":"push","kind":"secret","username":null,"expires_at":1794380000}',
        'event: secret.request\ndata: {"name":"missing-id"}',
        'event: assistant.completed\ndata: {"content":"Pushed."}',
        'event: run.completed\ndata: {"session_id":"sess_1"}',
        "event: done\ndata: {}",
      ].join("\n\n") + "\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "x-hermes-session-id": "sess_1" } })),
    );
    const seen: ChatSecretRequest[] = [];
    await streamChatTurn(
      { sessionId: "sess_1", message: "push it", attachments: [] },
      { onSecretRequest: (req) => seen.push(req) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestId: "sr_0123456789abcdef", name: "github-pat" });
  });
});

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTicket } from "@/lib/ticket";

// Minted exactly as agent-home's mintAppTicket does.
function mint(key: string, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `v1.${payload}.${createHmac("sha256", key).update(`v1.${payload}`).digest("base64url")}`;
}

const NOW = 1_800_000_000_000;
const iat = NOW / 1000;
const good = { sub: "alice", role: "member", name: "Alice", aud: "notes/dev", iat, exp: iat + 60 };

describe("verifyTicket", () => {
  it("accepts a live ticket for this app and mode", () => {
    expect(verifyTicket(mint("k", good), "k", "notes/dev", NOW)?.sub).toBe("alice");
  });

  it("refuses a plain id, a forged or foreign ticket, a sibling's audience and an expired one", () => {
    expect(verifyTicket("alice", "k", "notes/dev", NOW)).toBeNull();
    expect(verifyTicket(mint("other-key", good), "k", "notes/dev", NOW)).toBeNull();
    expect(verifyTicket(mint("k", { ...good, aud: "notes/prod" }), "k", "notes/dev", NOW)).toBeNull();
    expect(verifyTicket(mint("k", { ...good, exp: iat - 1 }), "k", "notes/dev", NOW)).toBeNull();
    expect(verifyTicket(mint("k", good), undefined, "notes/dev", NOW)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  appAudience,
  deriveAppKey,
  mintAppTicket,
  verifyAppTicket,
  APP_TICKET_TTL_SECONDS,
} from "@/lib/apps/ticket";
import type { Principal } from "@/types";

const MASTER = "master-secret";
const NOW = 1_800_000_000_000;
const ann: Principal = {
  user_id: "ann",
  display: "Ann Lé",
  role: "member",
  channels: [],
  is_owner: false,
};

describe("app principal ticket", () => {
  it("verifies for the app it was minted for, with the visitor's identity", () => {
    const ticket = mintAppTicket(ann, "notes", "prod", MASTER, NOW);
    const claims = verifyAppTicket(ticket, deriveAppKey(MASTER, "notes", "prod"), "notes/prod", NOW);
    expect(claims).toMatchObject({ sub: "ann", role: "member", name: "Ann Lé", aud: "notes/prod" });
    expect(claims!.exp - claims!.iat).toBe(APP_TICKET_TTL_SECONDS);
  });

  it("is useless to a sibling app or the other mode of the same app", () => {
    const ticket = mintAppTicket(ann, "notes", "prod", MASTER, NOW);
    for (const [slug, mode] of [
      ["other", "prod"],
      ["notes", "dev"],
    ] as const) {
      const key = deriveAppKey(MASTER, slug, mode);
      expect(verifyAppTicket(ticket, key, appAudience(slug, mode), NOW)).toBeNull();
      // Even an app that knows the right audience string cannot verify with its own key.
      expect(verifyAppTicket(ticket, key, "notes/prod", NOW)).toBeNull();
    }
  });

  it("gives each app instance a distinct key that does not reveal the master", () => {
    const keys = new Set([
      deriveAppKey(MASTER, "notes", "prod"),
      deriveAppKey(MASTER, "notes", "dev"),
      deriveAppKey(MASTER, "other", "prod"),
    ]);
    expect(keys.size).toBe(3);
    expect([...keys].some((k) => k.includes(MASTER))).toBe(false);
  });

  it("expires after the TTL", () => {
    const ticket = mintAppTicket(ann, "notes", "prod", MASTER, NOW);
    const key = deriveAppKey(MASTER, "notes", "prod");
    expect(verifyAppTicket(ticket, key, "notes/prod", NOW + 59_000)).not.toBeNull();
    expect(verifyAppTicket(ticket, key, "notes/prod", NOW + 60_000)).toBeNull();
  });

  it("rejects a ticket whose claims were edited", () => {
    const ticket = mintAppTicket(ann, "notes", "prod", MASTER, NOW);
    const [v, payload, sig] = ticket.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "leo", role: "owner" })).toString(
      "base64url",
    );
    const key = deriveAppKey(MASTER, "notes", "prod");
    expect(verifyAppTicket(`${v}.${forged}.${sig}`, key, "notes/prod", NOW)).toBeNull();
    expect(verifyAppTicket("forged", key, "notes/prod", NOW)).toBeNull();
  });
});

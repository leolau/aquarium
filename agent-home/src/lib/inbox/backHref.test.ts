import { describe, expect, it } from "vitest";

import { inboxBackHref } from "./backHref";

describe("inboxBackHref", () => {
  it("returns Home for a row opened from the landing Incomings tab", () => {
    expect(inboxBackHref("landing")).toBe("/");
    expect(inboxBackHref(["landing", "?x"])).toBe("/");
  });

  it("keeps an Inbox query string and refuses anything else", () => {
    expect(inboxBackHref("?tab=arrived&surface=email")).toBe("/inbox?tab=arrived&surface=email");
    expect(inboxBackHref("//evil.example")).toBe("/inbox");
    expect(inboxBackHref("https://evil.example")).toBe("/inbox");
    expect(inboxBackHref(undefined)).toBe("/inbox");
  });
});

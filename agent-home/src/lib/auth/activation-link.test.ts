import { describe, expect, it } from "vitest";

import { loginPathAfterActivation, parseActivationLink } from "./activation-link";

describe("parseActivationLink", () => {
  it("reads a legacy link as the default profile", () => {
    expect(parseActivationLink(["tok"])).toEqual({ token: "tok" });
  });

  it("reads the profile from a two-segment link", () => {
    expect(parseActivationLink(["hr", "tok"])).toEqual({ profile: "hr", token: "tok" });
  });

  it("refuses any other shape", () => {
    expect(parseActivationLink([])).toBeNull();
    expect(parseActivationLink(["a", "b", "c"])).toBeNull();
    expect(parseActivationLink(["hr", " "])).toBeNull();
  });
});

describe("loginPathAfterActivation", () => {
  it("signs in to the link's profile", () => {
    expect(loginPathAfterActivation("hr")).toBe("/login?profile=hr");
    expect(loginPathAfterActivation()).toBe("/login");
  });
});

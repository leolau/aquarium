import { describe, expect, it } from "vitest";

import { chooseLandingProfile } from "@/lib/auth/landing-profile";
import type { MyProfile } from "@/types";

const e = (name: string, active = true): MyProfile => ({
  name,
  role: "member",
  active,
  is_default: name === "default",
});

describe("chooseLandingProfile (FG-28 D1)", () => {
  const all = [e("sales"), e("default"), e("hr")];

  it("lands only in an active enrolment, whatever is requested or hinted", () => {
    for (const requested of ["sales", "finance", "", null]) {
      for (const hint of ["hr", "finance", null]) {
        const got = chooseLandingProfile([e("sales"), e("hr", false)], { requested, hint });
        expect(got).toEqual({ kind: "profile", profile: "sales" });
      }
    }
  });

  it("prefers requested, then hint, then default, then registry order", () => {
    expect(chooseLandingProfile(all, { requested: "hr", hint: "sales" })).toEqual({ kind: "profile", profile: "hr" });
    expect(chooseLandingProfile(all, { requested: "nope", hint: "sales" })).toEqual({ kind: "profile", profile: "sales" });
    expect(chooseLandingProfile(all, { hint: "nope" })).toEqual({ kind: "profile", profile: "default" });
    expect(chooseLandingProfile([e("sales"), e("hr")])).toEqual({ kind: "profile", profile: "sales" });
  });

  it("tells suspended-everywhere apart from enrolled-nowhere", () => {
    expect(chooseLandingProfile([e("default", false), e("hr", false)])).toEqual({ kind: "suspended" });
    expect(chooseLandingProfile([])).toEqual({ kind: "none" });
  });
});

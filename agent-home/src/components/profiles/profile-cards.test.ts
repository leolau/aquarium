import { describe, expect, it } from "vitest";

import type { ProfileInfo } from "@/types";

import { matchesSearch } from "./profile-cards";

const profile = (name: string, ref: string | null): ProfileInfo => ({
  name,
  ref,
  is_default: false,
  description: "",
  description_auto: false,
  model: null,
  provider: null,
  has_env: false,
  skill_count: 0,
  gateway_running: false,
});

describe("matchesSearch", () => {
  it("matches a profile ref exactly, not by prefix", () => {
    expect(matchesSearch(profile("triage", "A1"), undefined, "a1")).toBe(true);
    expect(matchesSearch(profile("sales", "A10"), undefined, "A1")).toBe(false);
  });

  it("still matches by name", () => {
    expect(matchesSearch(profile("triage", "A1"), undefined, "tri")).toBe(true);
  });
});

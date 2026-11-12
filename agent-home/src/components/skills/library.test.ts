import { describe, expect, it } from "vitest";

import {
  addCandidates,
  canDelete,
  filterLibrary,
  kindCount,
  libraryRows,
  librarySourceLabel,
  needsCopyChoice,
  profileSkills,
} from "@/components/skills/library";
import type { SkillLibrary, TriageStatus } from "@/types";

const LIB: SkillLibrary = {
  profiles: ["default", "hr", "engineers"],
  skills: [
    { name: "google-workspace", description: "Gmail", category: "productivity", source: "builtin", owners: [], used_by: [{ profile: "default", enabled: true }, { profile: "hr", enabled: false }] },
    { name: "linear", description: "Issues", category: "dev", source: "hub", trust_level: "trusted", owners: [], used_by: [{ profile: "engineers", enabled: true }] },
    { name: "docx-editing", description: "Word", category: "productivity", source: "shared", owners: [], used_by: [{ profile: "hr", enabled: true }] },
    { name: "leave-policy-hk", description: "Leave", category: "hr", source: "profile", owners: ["hr"], used_by: [{ profile: "hr", enabled: true }] },
  ],
};

const TRIAGE = {
  profile: "default",
  kinds: [
    { kind: "email", label: "Email triage", status: "set_up", skills: [{ name: "email-triage", layer: "base", path: "", present: true, files: [] }, { name: "email-triage-custom", layer: "custom", path: "", present: true, files: [] }] },
  ],
} as unknown as TriageStatus;

describe("skills library helpers", () => {
  it("splits a profile's skills into on and removed", () => {
    const { on, off } = profileSkills(LIB, "hr");
    expect(on.map((s) => s.name)).toEqual(["docx-editing", "leave-policy-hk"]);
    expect(off.map((s) => s.name)).toEqual(["google-workspace"]);
  });

  it("offers every skill the profile doesn't have on, never a triage skill", () => {
    expect(addCandidates(LIB, "hr").map((s) => s.name)).toEqual(["google-workspace", "linear"]);
    expect(addCandidates(LIB, "hr").some((s) => s.name === "email-triage")).toBe(false);
  });

  it("asks where to copy a profile-only skill from another profile, only then", () => {
    const leave = LIB.skills[3];
    expect(needsCopyChoice(leave, "engineers")).toBe(true);
    expect(needsCopyChoice(leave, "hr")).toBe(false);
    expect(needsCopyChoice(LIB.skills[1], "hr")).toBe(false);
  });

  it("allows Delete only on the profile's own skill", () => {
    expect(canDelete(LIB.skills[3], "hr")).toBe(true);
    expect(canDelete(LIB.skills[3], "engineers")).toBe(false);
    for (const s of LIB.skills.slice(0, 3)) expect(canDelete(s, "hr")).toBe(false);
  });

  it("labels sources", () => {
    expect(LIB.skills.map(librarySourceLabel)).toEqual(["built-in", "hub · trusted", "shared", "hr only"]);
  });

  it("adds triage base folders as triage rows and filters by kind, profile and search", () => {
    const rows = libraryRows(LIB, TRIAGE);
    expect(rows.filter((r) => r.kind === "triage").map((r) => r.name)).toEqual(["email-triage"]);
    expect(kindCount(rows, "all")).toBe(5);
    const base = { kind: "all" as const, category: "", profile: "", search: "" };
    expect(filterLibrary(rows, { ...base, kind: "triage" }).map((r) => r.name)).toEqual(["email-triage"]);
    expect(filterLibrary(rows, { ...base, profile: "engineers" }).map((r) => r.name)).toEqual(["linear"]);
    expect(filterLibrary(rows, { ...base, search: "word" }).map((r) => r.name)).toEqual(["docx-editing"]);
  });
});

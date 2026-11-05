import { describe, expect, it } from "vitest";

import { categoryCounts, filterSkills, skillTemplate, sourceLabel } from "@/components/skills/skill-filters";
import type { SkillInfo } from "@/types";

const S: SkillInfo[] = [
  { name: "email-triage", description: "Sort mail", category: "email", enabled: true, source: "local" },
  { name: "pr-review", description: "Review PRs", category: "github", enabled: false, source: "hub", trust_level: "trusted" },
  { name: "scenes", description: "Home scenes", category: "email", enabled: true, source: "builtin" },
];

describe("skill filters", () => {
  it("counts categories and filters by state, category and search", () => {
    expect(categoryCounts(S)).toEqual([["email", 2], ["github", 1]]);
    expect(filterSkills(S, { kind: "enabled" }, "").map((s) => s.name)).toEqual(["email-triage", "scenes"]);
    expect(filterSkills(S, { kind: "disabled" }, "").map((s) => s.name)).toEqual(["pr-review"]);
    expect(filterSkills(S, { kind: "category", category: "email" }, "home").map((s) => s.name)).toEqual(["scenes"]);
  });

  it("labels where a skill came from", () => {
    expect(S.map(sourceLabel)).toEqual(["created here", "hub · trusted", "builtin"]);
  });

  it("drafts SKILL.md frontmatter with optional sources", () => {
    const md = skillTemplate("expense-report", "File an\nexpense", "https://a\n\nhttps://b");
    expect(md).toContain("name: expense-report\ndescription: File an expense\n---");
    expect(md).toContain("## Sources\n\n- https://a\n- https://b");
    expect(skillTemplate("x", "", "")).not.toContain("Sources");
  });
});

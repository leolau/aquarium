import { describe, expect, it } from "vitest";

import { authorLabel, defaultPair, pairFor, parseUnifiedDiff, timeAgo, toVersionList, type SkillVersionList } from "@/lib/skills/versions";

const LIST: SkillVersionList = toVersionList({
  name: "q",
  active: "v2",
  versions: [
    { id: "v1", n: 1, status: "archived", source: "baseline", parent: null },
    { id: "v2", n: 2, status: "active", source: "edit", parent: "v1" },
    { id: "v3", n: 3, status: "draft", source: "improve", parent: "v2" },
  ],
});

describe("skill versions helpers", () => {
  it("numbers unified diff rows on both sides and counts changes", () => {
    const text = [
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -40,4 +40,4 @@ Steps",
      " ## Steps",
      "-1. Read the brief.",
      "+1. Read the brief and confirm currency.",
      "--- not a header inside a hunk",
      " 2. Price each line.",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d.files).toEqual(["SKILL.md"]);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(2);
    const lines = d.rows.filter((r) => r.kind === "add" || r.kind === "del" || r.kind === "same");
    expect(lines.map((r) => ("oldNo" in r ? [r.kind, r.oldNo, r.newNo] : []))).toEqual([
      ["same", 40, 40],
      ["del", 41, null],
      ["add", null, 41],
      ["del", 42, null],
      ["same", 43, 42],
    ]);
    expect(parseUnifiedDiff("").rows).toEqual([]);
  });

  it("defaults the compare pair to active → newest draft", () => {
    expect(defaultPair(LIST)).toEqual(["v2", "v3"]);
    expect(pairFor(LIST, "v1")).toEqual(["v2", "v1"]);
    expect(pairFor(LIST, "v2")).toEqual(["v1", "v2"]);
    expect(defaultPair(toVersionList({ active: "v1", versions: [{ id: "v1", n: 1, status: "active" }] }))).toBeNull();
  });

  it("labels authors and times for people", () => {
    expect(authorLabel("user:leo")).toBe("leo");
    expect(authorLabel("agent:abc")).toBe("agent");
    expect(authorLabel("curator")).toBe("curator");
    const now = Date.UTC(2026, 10, 8, 12);
    expect(timeAgo(now / 1000 - 120, now)).toBe("2 min ago");
    expect(timeAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3h ago");
    expect(timeAgo(null, now)).toBe("");
  });
});

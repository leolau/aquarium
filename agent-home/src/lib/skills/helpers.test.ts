import { describe, expect, it } from "vitest";

import { changedLineCount, diffLines, hunks } from "./diff";
import { applyFormat } from "./format";
import { extractHeadings, slugger } from "./outline";
import { hasErrors, unclosedFence, validateSkill } from "./validate";

const good = "---\nname: pdf\ndescription: Fill PDFs. Use when a task involves a PDF.\nversion: 1.0.0\n---\n\n# PDF\n\nText\n";

describe("validateSkill", () => {
  it("passes a good skill", () => {
    const checks = validateSkill(good, "pdf");
    expect(hasErrors(checks)).toBe(false);
    expect(checks.map((c) => c.level)).toEqual(["ok", "ok", "ok"]);
  });

  it("catches the backend's hard errors", () => {
    expect(hasErrors(validateSkill("# no header", "pdf"))).toBe(true);
    expect(hasErrors(validateSkill(good.replace("name: pdf", "name: other"), "pdf"))).toBe(true);
    expect(hasErrors(validateSkill(good.replace(/description: .*\n/, ""), "pdf"))).toBe(true);
    expect(hasErrors(validateSkill(good.replace(/description: .*\n/, `description: ${"x".repeat(1025)}\n`), "pdf"))).toBe(true);
    expect(hasErrors(validateSkill(good.replace("# PDF\n\nText\n", "  \n"), "pdf"))).toBe(true);
    expect(hasErrors(validateSkill(good + "x".repeat(100_001), "pdf"))).toBe(true);
  });

  it("warns without blocking", () => {
    const checks = validateSkill(good.replace("Use when a task involves a PDF.", "PDF helper.").replace("Text", "```\ncode"), "pdf");
    expect(hasErrors(checks)).toBe(false);
    expect(checks.filter((c) => c.level === "warn")).toHaveLength(2);
  });

  it("detects unclosed fences", () => {
    expect(unclosedFence("```py\nx\n```")).toBe(false);
    expect(unclosedFence("````\n```\n")).toBe(true);
    expect(unclosedFence("~~~\nx")).toBe(true);
  });
});

describe("diff", () => {
  it("diffs lines and counts a replaced line once", () => {
    const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(ops.map((o) => `${o.type[0]}${o.text}`)).toEqual(["sa", "db", "aB", "sc", "sd", "ae"]);
    expect(changedLineCount(ops)).toBe(2);
    expect(changedLineCount(diffLines("x", "x"))).toBe(0);
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 30 }, (_, k) => `l${k}`).join("\n");
    const out = hunks(diffLines(before, before.replace("l15", "L15")), 2);
    expect(out[0]).toEqual({ skipped: 13 });
    expect("ops" in out[1] && out[1].ops).toHaveLength(6);
    expect(out[2]).toEqual({ skipped: 12 });
  });
});

describe("outline", () => {
  it("lists headings outside code with unique ids", () => {
    const md = "# Title\n\n## Step `one`\n```\n## not a heading\n```\n### Step one\n#### deep\n## Title";
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Title", id: "sec-title" },
      { level: 2, text: "Step one", id: "sec-step-one" },
      { level: 3, text: "Step one", id: "sec-step-one-1" },
      { level: 2, text: "Title", id: "sec-title-1" },
    ]);
  });

  it("slugs non-Latin text", () => {
    expect(slugger()("步驟 一")).toBe("sec-步驟-一");
  });
});

describe("applyFormat", () => {
  it("wraps the selection", () => {
    expect(applyFormat("say hi", 4, 6, "bold")).toEqual({ text: "say **hi**", start: 6, end: 8 });
    expect(applyFormat("x", 1, 1, "code").text).toBe("x`code`");
    expect(applyFormat("go", 0, 2, "link")).toEqual({ text: "[go](https://)", start: 5, end: 13 });
  });

  it("prefixes and un-prefixes lines", () => {
    const listed = applyFormat("a\nb", 0, 3, "list");
    expect(listed.text).toBe("- a\n- b");
    expect(applyFormat(listed.text, 0, listed.text.length, "list").text).toBe("a\nb");
    expect(applyFormat("a\nb", 0, 3, "numbered").text).toBe("1. a\n2. b");
    expect(applyFormat("x\nTitle\ny", 3, 3, "heading").text).toBe("x\n## Title\ny");
  });

  it("puts blocks on their own lines", () => {
    expect(applyFormat("ab", 1, 1, "codeblock").text).toBe("a\n```\ncode\n```\nb");
    expect(applyFormat("", 0, 0, "table").text).toContain("| --- |");
  });
});

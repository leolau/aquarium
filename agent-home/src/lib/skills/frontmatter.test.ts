import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { getBody, isListField, parseSkill, setBody, setMetaField, splitDoc, UnsupportedFieldError, type MetaField } from "./frontmatter";

const DOC = `---
name: pdf-tools
# keep this comment
description: "Read, fill and merge PDFs. Use when a task involves a PDF file."
version: 2.3.1
author: Hermes team
license: MIT
platforms: [linux, macos]
x-custom:
  nested: [1, 2]
  keep: yes
metadata:
  hermes:
    tags: [pdf, documents]
    related_skills:
      - ocr-and-documents
      - excel-reports
    category: productivity
    config:
      - key: pdf.dpi
---

# PDF tools

Body text.
`;

function shippedSkills(): string[] {
  const walk = (d: string): string[] =>
    fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "SKILL.md" ? [path.join(d, e.name)] : []))
      : [];
  return [...walk(path.resolve(__dirname, "../../../../skills")), ...walk(path.resolve(__dirname, "../../../../optional-skills"))];
}

describe("splitDoc", () => {
  it("splits and rejoins byte-for-byte", () => {
    const s = splitDoc(DOC);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.head + s.yaml + s.close + s.body).toBe(DOC);
    expect(s.yaml.startsWith("name: pdf-tools\n")).toBe(true);
    expect(s.close).toBe("---\n");
  });

  it("reports a missing or unclosed header", () => {
    expect(splitDoc("# just markdown").hasFrontmatter).toBe(false);
    const open = splitDoc("---\nname: x\n# no close");
    expect(open.hasFrontmatter).toBe(false);
    expect(open.unclosed).toBe(true);
    expect(parseSkill("---\nname: x\n").problems[0]).toMatch(/not closed/);
  });
});

describe("parseSkill", () => {
  it("reads the documented fields", () => {
    const { meta, unsupported, problems } = parseSkill(DOC);
    expect(problems).toEqual([]);
    expect(unsupported).toEqual([]);
    expect(meta).toEqual({
      name: "pdf-tools",
      description: "Read, fill and merge PDFs. Use when a task involves a PDF file.",
      version: "2.3.1",
      author: "Hermes team",
      license: "MIT",
      platforms: ["linux", "macos"],
      tags: ["pdf", "documents"],
      related_skills: ["ocr-and-documents", "excel-reports"],
      category: "productivity",
    });
  });

  it("reads block scalars, quoted strings and top-level tags", () => {
    const doc = `---\nname: x\ndescription: >\n  Folded line one\n  and two.\nauthor: 'O''Brien'\ntags: ["a, b", c]\n---\nbody\n`;
    const { meta } = parseSkill(doc);
    expect(meta.description).toBe("Folded line one and two.");
    expect(meta.author).toBe("O'Brien");
    expect(meta.tags).toEqual(["a, b", "c"]);
  });

  it("flags header lines that aren't key: value pairs", () => {
    expect(parseSkill("---\nname: x\njust some words\n---\nbody").problems[0]).toMatch(/line 3/);
  });
});

describe("setMetaField", () => {
  it("is a no-op when the value is unchanged", () => {
    const { meta } = parseSkill(DOC);
    for (const field of Object.keys(meta) as MetaField[]) expect(setMetaField(DOC, field, meta[field])).toBe(DOC);
  });

  it("rewrites only the changed field and keeps unknown keys and comments", () => {
    let doc = setMetaField(DOC, "version", "2.4.0");
    doc = setMetaField(doc, "tags", ["pdf", "documents", "forms"]);
    doc = setMetaField(doc, "related_skills", ["ocr-and-documents"]);
    doc = setMetaField(doc, "description", 'Says "hi": when asked.');
    expect(doc).toContain("version: 2.4.0\n");
    expect(doc).toContain("    tags: [pdf, documents, forms]\n");
    expect(doc).toContain("    related_skills:\n      - ocr-and-documents\n    category");
    expect(doc).toContain('description: "Says \\"hi\\": when asked."\n');
    expect(doc).toContain("# keep this comment\n");
    expect(doc).toContain("x-custom:\n  nested: [1, 2]\n  keep: yes\n");
    expect(doc).toContain("    config:\n      - key: pdf.dpi\n---\n");
    expect(parseSkill(doc).meta.description).toBe('Says "hi": when asked.');
    // Reverting every field brings back the original bytes.
    const original = parseSkill(DOC).meta;
    let back = doc;
    for (const f of ["version", "tags", "related_skills"] as MetaField[]) back = setMetaField(back, f, original[f]);
    back = back.replace('description: "Says \\"hi\\": when asked."', `description: "${original.description}"`);
    expect(back).toBe(DOC);
  });

  it("adds missing fields (creating metadata.hermes) and removes emptied ones", () => {
    const bare = "---\nname: x\ndescription: Use when testing.\nother: 1\n---\n\nBody\n";
    let doc = setMetaField(bare, "category", "dev");
    doc = setMetaField(doc, "tags", ["a"]);
    doc = setMetaField(doc, "version", "1.0");
    doc = setMetaField(doc, "platforms", ["linux"]);
    expect(splitDoc(doc).yaml).toBe(
      'name: x\ndescription: Use when testing.\nversion: "1.0"\nplatforms: [linux]\nother: 1\nmetadata:\n  hermes:\n    category: dev\n    tags: [a]\n',
    );
    expect(parseSkill(doc).meta).toMatchObject({ version: "1.0", category: "dev", tags: ["a"], platforms: ["linux"] });
    doc = setMetaField(doc, "version", "");
    doc = setMetaField(doc, "platforms", []);
    expect(doc).not.toMatch(/version|platforms/);
  });

  it("quotes values YAML would otherwise change", () => {
    const base = "---\nname: x\ndescription: d\n---\nb";
    for (const v of ["yes", "1.5", "a: b", "#hash", "- dash", " padded", "null"]) {
      expect(parseSkill(setMetaField(base, "author", v)).meta.author).toBe(v);
    }
    expect(parseSkill(setMetaField(base, "tags", ["a,b", "[x]", "ok"])).meta.tags).toEqual(["a,b", "[x]", "ok"]);
  });

  it("refuses fields it can't rewrite safely", () => {
    const doc = "---\nname: x\ndescription: d\nauthor: [a, b]\nmetadata: {hermes: {tags: [a]}}\n---\nb";
    const parsed = parseSkill(doc);
    expect(parsed.meta.author).toBe("a, b");
    expect(parsed.unsupported).toEqual(expect.arrayContaining(["author", "tags", "category"]));
    expect(() => setMetaField(doc, "author", "c")).toThrow(UnsupportedFieldError);
    expect(() => setMetaField(doc, "tags", ["b"])).toThrow(UnsupportedFieldError);
  });
});

describe("body", () => {
  it("edits the body without touching the header", () => {
    expect(getBody(DOC)).toBe("# PDF tools\n\nBody text.\n");
    const next = setBody(DOC, "# New\n");
    expect(next).toBe(DOC.replace("# PDF tools\n\nBody text.\n", "# New\n"));
    expect(setBody(DOC, getBody(DOC))).toBe(DOC);
  });
});

describe("every shipped skill round-trips", () => {
  const files = shippedSkills();
  it("finds the shipped skills", () => expect(files.length).toBeGreaterThan(20));
  it.each(files.map((f) => [path.relative(path.resolve(__dirname, "../../../.."), f), f]))("%s", (_rel, file) => {
    const doc = fs.readFileSync(file, "utf8");
    const parsed = parseSkill(doc);
    expect(parsed.problems).toEqual([]);
    expect(parsed.meta.name).not.toBe("");
    expect(setBody(doc, getBody(doc))).toBe(doc);
    for (const field of Object.keys(parsed.meta) as MetaField[]) {
      if (parsed.unsupported.includes(field)) continue;
      expect(setMetaField(doc, field, parsed.meta[field])).toBe(doc);
      const changed = isListField(field) ? [...(parsed.meta[field] as string[]), "added tag"] : `${parsed.meta[field] as string} (edited: yes)`;
      const after = parseSkill(setMetaField(doc, field, changed));
      expect(after.meta[field]).toEqual(changed);
      expect({ ...after.meta, [field]: null }).toEqual({ ...parsed.meta, [field]: null });
    }
  });
});

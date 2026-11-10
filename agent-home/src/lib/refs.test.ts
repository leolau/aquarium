/** Short-ref parsing mirrors `hermes_cli/short_refs.py#parse_ref` (FG-36). */
import { describe, expect, it } from "vitest";

import { parseRef, refHref } from "./refs";

describe("parseRef", () => {
  it.each([
    ["P12", "P12", null],
    ["p12", "P12", null],
    [" t345 ", "T345", null],
    ["P12-R3", "P12-R3", 3],
    ["p12-r3", "P12-R3", 3],
    ["c1024", "C1024", null],
    ["D88", "D88", null],
    ["M512", "M512", null],
  ])("reads %s as %s", (text, ref, runNo) => {
    const parsed = parseRef(text);
    expect(parsed?.ref).toBe(ref);
    expect(parsed?.runNo).toBe(runNo);
    expect(parseRef(parsed!.ref)).toEqual(parsed);
  });

  it.each(["", "P", "P0", "P012", "P12-R0", "P12-R03", "T12-R3", "X12", "PP12", "t_1a2b3c4d", "digest"])(
    "rejects %j",
    (text) => {
      expect(parseRef(text)).toBeNull();
    },
  );

  it("treats null and undefined as no ref", () => {
    expect(parseRef(null)).toBeNull();
    expect(parseRef(undefined)).toBeNull();
  });
});

describe("refHref", () => {
  it("opens through /go", () => {
    expect(refHref("P12-R3")).toBe("/go/P12-R3");
  });
});

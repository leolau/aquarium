/** The "Open D88" jump under a list's search box (FG-36). */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RefJump } from "./RefJump";

const label = (ref: string) => `Open ${ref}`;

describe("RefJump", () => {
  it("links a typed ref of the list's kind to /go/<ref>", () => {
    const html = renderToStaticMarkup(<RefJump query=" d88 " kind="D" label={label} />);
    expect(html).toContain('href="/go/D88"');
    expect(html).toContain("Open D88");
    expect(renderToStaticMarkup(<RefJump query="m512" kind="M" label={label} />)).toContain(
      'href="/go/M512"',
    );
  });

  it("stays out of the way for other kinds and plain words", () => {
    for (const query of ["", "invoice", "M512", "D088", "P12"]) {
      expect(renderToStaticMarkup(<RefJump query={query} kind="D" label={label} />)).toBe("");
    }
  });
});

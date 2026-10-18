import { describe, expect, it } from "vitest";

import {
  FILE_RESPONSE_CSP,
  applyFileSafetyHeaders,
  contentDisposition,
  filenameFromDisposition,
  isInlineSafe,
} from "@/lib/http/file-headers";

function apply(type: string | null, opts: { filename?: string; download?: boolean } = {}) {
  const h = new Headers();
  if (type) h.set("content-type", type);
  return applyFileSafetyHeaders(h, { filename: "x", ...opts });
}

describe("isInlineSafe", () => {
  it.each(["image/png", "IMAGE/JPEG; charset=binary", "video/mp4", "audio/mpeg", "application/pdf", "text/plain; charset=utf-8"])(
    "lets %s open inline",
    (type) => expect(isInlineSafe(type)).toBe(true),
  );

  it.each(["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "text/javascript", "application/octet-stream", "", null])(
    "never opens %s inline",
    (type) => expect(isInlineSafe(type)).toBe(false),
  );
});

describe("applyFileSafetyHeaders", () => {
  it("sends nosniff and the sandbox CSP on every file response", () => {
    for (const type of ["image/png", "text/html", null]) {
      const h = apply(type);
      expect(h.get("x-content-type-options")).toBe("nosniff");
      expect(h.get("content-security-policy")).toBe(FILE_RESPONSE_CSP);
      expect(h.get("content-security-policy")).toMatch(/^sandbox;/);
      expect(h.get("content-security-policy")).toContain("default-src 'none'");
    }
  });

  it("forces a download for HTML and SVG even when inline was asked for", () => {
    expect(apply("text/html", { filename: "invoice.html" }).get("content-disposition")).toMatch(/^attachment;/);
    expect(apply("image/svg+xml").get("content-disposition")).toMatch(/^attachment;/);
  });

  it("keeps safe types inline unless the caller asked to download", () => {
    expect(apply("image/png").get("content-disposition")).toMatch(/^inline;/);
    expect(apply("application/pdf").get("content-disposition")).toMatch(/^inline;/);
    expect(apply("image/png", { download: true }).get("content-disposition")).toMatch(/^attachment;/);
  });

  it("replaces a missing content type with octet-stream and downloads it", () => {
    const h = apply(null);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("content-disposition")).toMatch(/^attachment;/);
  });
});

describe("Content-Disposition filenames", () => {
  it("round-trips a non-Latin name and keeps the ASCII fallback header-safe", () => {
    const value = contentDisposition("inline", '合約 "v2".pdf');
    expect(value).not.toMatch(/[^\x20-\x7e]/);
    expect(value).toContain('filename="__ _v2_.pdf"');
    expect(filenameFromDisposition(value)).toBe('合約 "v2".pdf');
  });

  it("reads Starlette's plain and RFC 5987 forms", () => {
    expect(filenameFromDisposition('inline; filename="mou.docx"')).toBe("mou.docx");
    expect(filenameFromDisposition("attachment; filename*=utf-8''%E5%90%88.docx")).toBe("合.docx");
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

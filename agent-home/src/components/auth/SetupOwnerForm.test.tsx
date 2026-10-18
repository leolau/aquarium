import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SETUP_LINK_INVALID,
  SetupOwnerForm,
  setupFormError,
  tokenFromHash,
} from "@/components/auth/SetupOwnerForm";

describe("tokenFromHash", () => {
  it("reads the token from the fragment hermes setup-link prints", () => {
    expect(tokenFromHash("#token=Qm9-abc_123")).toBe("Qm9-abc_123");
    expect(tokenFromHash("token=xyz")).toBe("xyz");
  });

  it("returns empty for a missing or empty token", () => {
    expect(tokenFromHash("")).toBe("");
    expect(tokenFromHash("#")).toBe("");
    expect(tokenFromHash("#token=")).toBe("");
    expect(tokenFromHash("#other=1")).toBe("");
  });
});

describe("setupFormError", () => {
  const good = "correct horse battery";
  it("accepts a valid email and matching 12+ character passwords", () => {
    expect(setupFormError("owner@example.com", good, good)).toBeNull();
  });
  it("rejects a bad email, a short password and a mismatch", () => {
    expect(setupFormError("owner", good, good)).toMatch(/email/);
    expect(setupFormError("owner@example.com", "short", "short")).toMatch(/12/);
    expect(setupFormError("owner@example.com", good, `${good}!`)).toMatch(/match/);
  });
});

describe("SetupOwnerForm", () => {
  it("starts by checking the link and never renders a token", () => {
    const html = renderToStaticMarkup(<SetupOwnerForm />);
    expect(html).toContain('data-component="SetupChecking"');
    expect(html).not.toContain("token=");
  });

  it("tells the reader how to get a new link", () => {
    expect(SETUP_LINK_INVALID).toContain("hermes setup-link");
  });
});

import { describe, expect, it } from "vitest";

import { accountName } from "./account-name";

describe("accountName", () => {
  it("prefers the display name", () => {
    expect(accountName({ display: " Yan ", user_id: "yan_admin" })).toBe("Yan");
  });

  it("falls back to a readable user id when the display name is empty", () => {
    expect(accountName({ display: "", user_id: "leo_owner" })).toBe("leo_owner");
  });

  it("never shows a UUID user id", () => {
    expect(accountName({ display: "", user_id: "13c35df0-90c6-48eb-8cd1-a5ef3f1f09b7" })).toBeNull();
  });
});

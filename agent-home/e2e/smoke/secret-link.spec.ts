import { expect, test } from "../support/fixtures";
import { component } from "../support/ui";

test.describe("one-time secret link (FG-37)", { tag: "@smoke" }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("opens signed out, private, and an unknown link shows the neutral card", async ({ page }) => {
    const res = await page.goto(`/secret/${"x".repeat(43)}`);
    expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res?.headers()["cache-control"]).toContain("no-store");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(component(page, "SecretLinkUnusable")).toBeVisible();
  });
});

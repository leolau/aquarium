import { asRole, expect, test } from "../support/fixtures";
import { healthPill, openHealthReadings, statusRefresh } from "../support/ui";

test.describe("health pill", { tag: "@smoke" }, () => {
  asRole("admin");

  test("renders and refreshes on demand", async ({ page }) => {
    await page.goto("/");
    await expect(healthPill(page)).toBeVisible();
    const readings = await openHealthReadings(page);
    await expect(readings.locator('a[href="/capacity"]').first()).toBeVisible();

    const refreshed = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/status/summary" && res.request().method() === "GET",
    );
    await statusRefresh(readings).click();
    expect((await refreshed).ok()).toBe(true);
    await expect(statusRefresh(readings)).not.toHaveAttribute("aria-busy", "true");
    await expect(healthPill(page)).toBeVisible();
  });
});

import { asRole, expect, test } from "../support/fixtures";
import { statusRefresh, statusStrip } from "../support/ui";

test.describe("status strip", { tag: "@smoke" }, () => {
  asRole("admin");

  test("renders and refreshes on demand", async ({ page }) => {
    await page.goto("/");
    const strip = statusStrip(page);
    await expect(strip).toBeVisible();
    await expect(strip.locator('a[href="/capacity"]').first()).toBeVisible();

    const refreshed = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/status/summary" && res.request().method() === "GET",
    );
    await statusRefresh(page).click();
    expect((await refreshed).ok()).toBe(true);
    await expect(statusRefresh(page)).not.toHaveAttribute("aria-busy", "true");
    await expect(strip).toBeVisible();
  });
});

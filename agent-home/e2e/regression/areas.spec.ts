/** Read-only tours of the main areas, on both viewports. */
import { asRole, expect, test } from "../support/fixtures";
import { component, expectPageReady } from "../support/ui";

test.describe("areas", { tag: "@regression" }, () => {
  asRole("admin");

  test("inbox opens, and an arrival opens if there is one", async ({ page }) => {
    await page.goto("/inbox");
    await expectPageReady(page, "/inbox");
    const items = component(page, "IncomingsList").locator('a[href^="/inbox/"]');
    if ((await items.count()) > 0) {
      await items.first().click();
      await page.waitForURL(/\/inbox\/.+/, { waitUntil: "commit" });
      await expect(component(page, "MobileShell").last()).toBeVisible();
      await expect(page.locator('main [data-component$="Error"]')).toHaveCount(0);
    } else {
      await expect(component(page, "IncomingsEmpty")).toBeVisible();
    }
  });

  test("landing Scheduled button lands on Projects › Scheduled", async ({ page }) => {
    await page.goto("/");
    // Desktop strip only; hidden when nothing runs and nothing is scheduled.
    const button = page.locator('[data-component="RunningStrip"] [data-component="ScheduledButton"]');
    if (await button.isVisible()) {
      await expect(button).toHaveAttribute("href", "/projects?view=project&schedule=set");
    }
    await page.goto("/projects?view=project&schedule=set");
    await expectPageReady(page, "/projects");
    await expect(
      page.locator('[data-component="ProjectsFilters"] [data-view="scheduled"]'),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("files: list and browse", async ({ page }) => {
    await page.goto("/files");
    await expectPageReady(page, "/files");
    await page.goto("/files/browse");
    await expectPageReady(page, "/files/browse");
  });

  test("memory: map and list render", async ({ page }) => {
    await page.goto("/memory");
    await expectPageReady(page, "/memory");
    await expect(
      page.locator('[data-component="MemoryListPanel"], [data-component="MemoryMap"]').first(),
    ).toBeVisible();
  });

  test("capacity: indicators render", async ({ page }) => {
    await page.goto("/capacity");
    await expectPageReady(page, "/capacity");
    await expect(component(page, "CapacityIndicators")).toBeVisible();
  });
});

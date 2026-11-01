/**
 * Opens every item the role sees in the Coral menu and checks the page's
 * stable marker. The list is read from the menu itself, so per-role menu
 * visibility needs no change here — only PAGE_MARKERS for new routes.
 * Each destination is opened from Home, and one broken page does not hide
 * the others: failures are collected and reported together.
 */
import { asRole, expect, test } from "../support/fixtures";
import { coralRoutes, expectPageReady, openCoral } from "../support/ui";

test.describe("Coral menu: every destination renders", { tag: "@smoke" }, () => {
  asRole("admin");
  test.setTimeout(240_000);

  test("admin", async ({ page }) => {
    await page.goto("/");
    await expectPageReady(page, "/");
    const routes = await coralRoutes(page);
    expect(routes.length, "menu items").toBeGreaterThan(5);

    const failed: string[] = [];
    for (const route of routes) {
      await test.step(route, async () => {
        try {
          await page.goto("/");
          const menu = await openCoral(page);
          await menu.locator(`a[role="menuitem"][href="${route}"]`).click();
          await page.waitForURL((url) => url.pathname === route || url.pathname.startsWith(`${route}/`), {
            waitUntil: "commit",
          });
          await expectPageReady(page, new URL(page.url()).pathname);
        } catch (err) {
          failed.push(`${route}: ${String(err).split("\n")[0]}`);
        }
      });
    }
    expect(failed, "destinations that did not render").toEqual([]);
  });
});

/** Phone layout sanity: nothing scrolls sideways, the menu fits, chat is usable. */
import { asRole, expect, test } from "../support/fixtures";
import { chat, coralFab, coralMenu, expectPageReady, openCoral } from "../support/ui";

const PAGES = ["/", "/todos", "/chat", "/inbox", "/projects", "/files", "/memory", "/capacity", "/settings"];

test.describe("mobile layout", { tag: "@regression" }, () => {
  asRole("admin");
  test.skip(({ isMobile }) => !isMobile, "phone viewport only");

  for (const route of PAGES) {
    test(`${route} fits the screen`, async ({ page }) => {
      await page.goto(route);
      await expectPageReady(page, route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, "horizontal overflow (px)").toBeLessThanOrEqual(1);
      // The chat page hides the floating launcher on phones (its top bar opens the menu).
      if (route === "/chat") await expect(coralFab(page)).toBeHidden();
      else await expect(coralFab(page)).toBeInViewport();
    });
  }

  test("Coral menu opens inside the viewport", async ({ page }) => {
    await page.goto("/");
    await openCoral(page);
    await expect(coralMenu(page)).toBeInViewport();
    const box = await coralMenu(page).boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
  });

  test("chat composer is reachable", async ({ page }) => {
    await page.goto("/chat");
    await expect(chat.composer(page)).toBeInViewport();
    await expect(chat.send(page)).toBeVisible();
  });
});

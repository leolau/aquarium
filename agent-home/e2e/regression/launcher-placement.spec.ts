/** The floating lead-chat launcher never covers the chat composer's Send controls. */
import { asRole, expect, test } from "../support/fixtures";
import { chat, expectPageReady } from "../support/ui";

test.describe("lead-chat launcher placement", { tag: "@regression" }, () => {
  asRole("admin");

  test("sits clear of the composer's split Send button", async ({ page }) => {
    await page.goto("/chat");
    await expectPageReady(page, "/chat");
    const fab = page.getByRole("button", { name: "Open lead chat" });
    await expect(fab).toBeVisible();
    await expect(chat.send(page)).toBeVisible();
    const split = page
      .locator('[data-component="Composer"]')
      .getByRole("button");
    await expect(async () => {
      const f = (await fab.boundingBox())!;
      for (const b of await split.all()) {
        const box = await b.boundingBox();
        if (!box) continue;
        const overlaps =
          f.x < box.x + box.width &&
          box.x < f.x + f.width &&
          f.y < box.y + box.height &&
          box.y < f.y + f.height;
        expect(
          overlaps,
          `launcher overlaps ${(await b.getAttribute("aria-label")) ?? (await b.textContent())}`,
        ).toBe(false);
      }
    }).toPass();
  });
});

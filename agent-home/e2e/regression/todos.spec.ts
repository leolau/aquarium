/**
 * To-dos have no create form in the UI (they arrive from triage, chat and
 * projects), so the spec creates `[smoke]` rows through the same BFF route
 * those use, then completes and dismisses ("delete" in the UI) them by hand.
 */
import { smokeName, storageStatePath } from "../support/env";
import { sweepTodos } from "../support/cleanup";
import { asRole, desktopOnly, expect, test } from "../support/fixtures";
import { component } from "../support/ui";

test.describe("todos", { tag: "@regression" }, () => {
  asRole("admin");
  desktopOnly();

  test.afterAll(async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: storageStatePath("admin"),
    });
    await sweepTodos(ctx.request).finally(() => ctx.close());
  });

  test("create, complete and dismiss", async ({ page }) => {
    const done = smokeName("todo done");
    const dropped = smokeName("todo dismiss");
    await page.goto("/todos");
    for (const title of [done, dropped]) {
      const res = await page.request.post("/api/todos", { data: { title, stage: "open" } });
      expect(res.ok(), `create ${title}: ${res.status()}`).toBe(true);
    }

    await page.goto(`/todos?q=${encodeURIComponent("[smoke]")}`);
    const row = (title: string) => component(page, "TodoRow").filter({ hasText: title });

    await expect(row(done)).toBeVisible();
    await row(done).getByRole("button", { name: "Done" }).click();
    await expect(row(done).getByRole("button", { name: "Done" })).toHaveCount(0);

    await expect(row(dropped)).toBeVisible();
    await row(dropped).getByRole("button", { name: "Dismiss" }).click();
    await expect(row(dropped).getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  });
});

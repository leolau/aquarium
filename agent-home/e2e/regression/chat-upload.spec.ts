/**
 * Regression for the intermittent `invalid_form` chat upload: a ~300 KB
 * screenshot through the real composer file input, from a fresh page load
 * each time (the first upload after load failed most often), must succeed
 * every time. Everything uploaded is deleted again through the BFF.
 */
import { randomBytes } from "node:crypto";

import { storageStatePath } from "../support/env";
import { deleteChatUploads } from "../support/cleanup";
import { asRole, desktopOnly, expect, test } from "../support/fixtures";
import { component } from "../support/ui";

const RUNS = 10;
const uploaded: string[] = [];

test.describe("chat upload", { tag: "@regression" }, () => {
  asRole("admin");
  desktopOnly();

  test.afterAll(async ({ browser }, testInfo) => {
    if (!uploaded.length) return;
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: storageStatePath("admin"),
    });
    const deleted = await deleteChatUploads(ctx.request, uploaded).finally(() => ctx.close());
    expect(deleted).toBe(uploaded.length);
  });

  test(`a ~300 KB screenshot uploads ${RUNS}/${RUNS} times from a fresh page`, async ({ page }) => {
    test.setTimeout(RUNS * 30_000);
    const statuses: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      await page.goto("/chat");
      const composer = component(page, "Composer");
      const input = composer.locator('input[type="file"]');
      await expect(input).toBeAttached();
      // setInputFiles before hydration fires no React onChange (no request).
      await input.evaluate((el) =>
        new Promise<void>((resolve) => {
          const ready = () => Object.keys(el).some((k) => k.startsWith("__reactProps"));
          const tick = () => (ready() ? resolve() : setTimeout(tick, 50));
          tick();
        }),
      );
      const name = `Screenshot ${i + 1}\u202fat 10.00.00.png`;
      const response = page.waitForResponse(
        (res) => new URL(res.url()).pathname === "/api/chat/upload" && res.request().method() === "POST",
      );
      await input.setInputFiles({ name, mimeType: "image/png", buffer: randomBytes(300 * 1024) });
      const res = await response;
      statuses.push(res.status());
      if (res.ok()) {
        uploaded.push(((await res.json()) as { path: string }).path);
        await expect(composer.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
      }
    }
    expect(statuses).toEqual(Array(RUNS).fill(200));
  });
});

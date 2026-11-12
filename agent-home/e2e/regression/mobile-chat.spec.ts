/**
 * The chat page on a phone (390×844): no floating launchers over the chat, a
 * one-row title bar, a composer that starts at three lines and grows to 40%
 * of the visible height, 44px tap targets, and the keyboard-open layout.
 *
 * Headless Chromium has no on-screen keyboard, so the keyboard is simulated
 * the way iOS reports it: `window.visualViewport` shrinks while the layout
 * viewport keeps its height.
 */
import type { Locator, Page } from "@playwright/test";

import { asRole, expect, test } from "../support/fixtures";
import { chat, coralFab, coralMenu, expectPageReady } from "../support/ui";

declare global {
  interface Window {
    __setKeyboard?: (px: number) => void;
  }
}

function fakeVisualViewport() {
  let keyboard = 0;
  const vv = new EventTarget();
  Object.defineProperties(vv, {
    height: { get: () => window.innerHeight - keyboard },
    width: { get: () => window.innerWidth },
    offsetTop: { value: 0 },
    offsetLeft: { value: 0 },
    pageTop: { get: () => window.scrollY },
    pageLeft: { get: () => window.scrollX },
    scale: { value: 1 },
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  window.__setKeyboard = (px: number) => {
    keyboard = px;
    vv.dispatchEvent(new Event("resize"));
  };
}

const KEYBOARD_PX = 336;

const topBar = (page: Page) => page.locator('[data-component="TopBar"]');
const pageHeader = (page: Page) => page.locator('[data-component="PageHeader"]');

async function expectTapTargets(controls: Locator) {
  for (const control of await controls.all()) {
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    const name = (await control.getAttribute("aria-label")) ?? (await control.textContent())?.trim();
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
  }
}

test.describe("phone chat page", { tag: "@regression" }, () => {
  asRole("admin");
  test.skip(({ isMobile }) => !isMobile, "phone viewport only");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(fakeVisualViewport);
    await page.goto("/chat?new=1");
    await expectPageReady(page, "/chat");
  });

  test("no floating launchers; the top bar opens the Coral menu", async ({ page }) => {
    await expect(coralFab(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Open lead chat" })).toBeHidden();
    await expect(page.locator('[data-component="AttentionBanner"]')).toHaveCount(0);
    await expect(page.locator('[data-component="chat-dock"]')).toHaveCount(0);
    await page.locator('[data-action="open-coral"]').click();
    await expect(coralMenu(page)).toBeVisible();
  });

  test("title bar is one row and the menu reaches every chat action", async ({ page }) => {
    const header = pageHeader(page);
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
    await page.getByRole("button", { name: "More chat actions" }).click();
    const menu = page.getByRole("menu", { name: "Chat actions" });
    for (const label of ["All chats", "Details", "Filters & search", "Copy chat", "Archived"]) {
      await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
    }
    await expectTapTargets(menu.getByRole("menuitem"));
    await menu.getByRole("menuitem", { name: "Filters & search" }).click();
    await expect(page.getByRole("button", { name: /Filters & search/ })).toHaveAttribute("aria-expanded", "true");
  });

  test("chat controls are at least 44px", async ({ page }) => {
    await expectTapTargets(header(page));
    await expectTapTargets(page.locator('[data-component="Composer"] button'));
    await expectTapTargets(
      page.locator(
        '[data-action="open-coral"], [data-action="activity-pill"], [data-component="AttentionStrip"]',
      ),
    );
  });

  test("conversation gets most of the screen", async ({ page }) => {
    const thread = (await page.locator('[data-component="Composer"]').locator("xpath=preceding-sibling::div[1]").boundingBox())!;
    expect(thread.height).toBeGreaterThanOrEqual(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(overflow, "vertical overflow (px)").toBeLessThanOrEqual(1);
  });

  test("composer starts at three lines and grows to 40% of the screen", async ({ page }) => {
    const box = chat.composer(page);
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(80);
    await box.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    const vh = page.viewportSize()!.height;
    await expect(async () => {
      const h = (await box.boundingBox())!.height;
      expect(h).toBeLessThanOrEqual(vh * 0.4 + 1);
      expect(h).toBeGreaterThanOrEqual(vh * 0.4 - 4);
    }).toPass();
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });

  test("keyboard open: top bar folds away, title bar and composer sit above it", async ({ page }) => {
    const box = chat.composer(page);
    await box.focus();
    await page.evaluate((px) => window.__setKeyboard!(px), KEYBOARD_PX);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
    await expect(topBar(page)).toBeHidden();
    await expect(pageHeader(page)).toBeInViewport();
    const visible = page.viewportSize()!.height - KEYBOARD_PX;
    const composer = (await page.locator('[data-component="Composer"]').boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(visible + 1);
    await expect(chat.send(page)).toBeVisible();

    await box.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    await expect(async () => {
      expect((await box.boundingBox())!.height).toBeLessThanOrEqual(visible * 0.4 + 1);
    }).toPass();

    await page.evaluate(() => window.__setKeyboard!(0));
    await expect(page.locator("html")).not.toHaveAttribute("data-keyboard", "open");
    await expect(topBar(page)).toBeVisible();
  });
});

const header = pageHeader;

/**
 * One real turn in a throwaway `[smoke]` conversation: the reply only has to
 * start streaming. The conversation is archived through the UI, and swept by
 * API in afterAll in case the test died first.
 */
import { smokeName, storageStatePath } from "../support/env";
import { sweepChatSessions } from "../support/cleanup";
import { asRole, desktopOnly, expect, test } from "../support/fixtures";
import { chat, component } from "../support/ui";

test.describe("chat", { tag: "@smoke" }, () => {
  asRole("admin");
  desktopOnly();

  test.afterAll(async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: storageStatePath("admin"),
    });
    await sweepChatSessions(ctx.request).finally(() => ctx.close());
  });

  test("send a [smoke] message and see the reply start, then archive it", async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto("/chat");
    await expect(component(page, "ChatPane")).toBeVisible();

    await chat.newButton(page).click();
    await chat.composer(page).fill(`${smokeName("chat")} — reply with the single word: pong`);
    const streamed = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/chat/stream" && res.request().method() === "POST",
      { timeout: 60_000 },
    );
    await chat.send(page).click();
    const res = await streamed;
    expect(res.status()).toBe(200);

    await expect(chat.replyStarted(page).first()).toBeVisible({ timeout: 90_000 });

    // Archive through the conversation's own modal once the turn settled.
    await expect(chat.send(page)).toBeVisible({ timeout: 120_000 });
    await chat.activeChip(page).click();
    const modal = chat.modal(page);
    await expect(modal).toBeVisible();
    await modal.getByPlaceholder("Untitled conversation").fill(smokeName("chat"));
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();
    await chat.activeChip(page).click();
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(modal).toBeHidden();
  });
});

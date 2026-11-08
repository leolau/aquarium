import { credentials, ROLES } from "../support/env";
import { expect, test } from "../support/fixtures";
import { component, fillLogin } from "../support/ui";

const role = ROLES.find((r) => credentials(r) !== null);

test.describe("login / logout", { tag: "@smoke" }, () => {
  test.skip(!role, "no SMOKE_*_EMAIL/PASSWORD set");
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signed-out visitors are sent to the login form, and back after signing out", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);

    await fillLogin(page, credentials(role!)!);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { waitUntil: "commit" });
    await expect(component(page, "LandingComposer")).toBeVisible();

    await page.locator('[data-action="account-open"]').click();
    await component(page, "LogoutButton").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});

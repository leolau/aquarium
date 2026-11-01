/**
 * Signs each role with credentials in through the real login form once and
 * saves the browser state, so the specs start signed in without hammering
 * the login route (which is rate limited).
 */
import fs from "node:fs";

import { expect, test as setup } from "@playwright/test";

import { credentials, ROLES, storageStatePath } from "./support/env";
import { component, login } from "./support/ui";

for (const role of ROLES) {
  setup(`sign in as ${role}`, { tag: ["@smoke", "@regression"] }, async ({ page }) => {
    const creds = credentials(role);
    const file = storageStatePath(role);
    fs.rmSync(file, { force: true });
    setup.skip(!creds, `SMOKE_${role.toUpperCase()}_* not set`);
    await login(page, creds!);
    await expect(component(page, "MobileShell")).toBeVisible();
    await page.context().storageState({ path: file });
  });
}

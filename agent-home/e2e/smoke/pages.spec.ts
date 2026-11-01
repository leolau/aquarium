import { asRole, expect, test } from "../support/fixtures";
import { component, expectPageReady, projects } from "../support/ui";

test.describe("key pages", { tag: "@smoke" }, () => {
  asRole("admin");

  test("settings loads", async ({ page }) => {
    await page.goto("/settings");
    await expectPageReady(page, "/settings");
    await expect(component(page, "AccountSecurity")).toBeVisible();
  });

  test("projects list and a project page render", async ({ page }) => {
    await page.goto("/projects");
    await expectPageReady(page, "/projects");
    const links = projects.projectLinks(page);
    test.skip((await links.count()) === 0, "no projects visible to this account");
    const href = await links.first().getAttribute("href");
    await page.goto(href!);
    await expect(projects.detail(page)).toBeVisible();
    await expect(component(page, "ProjectHeader")).toBeVisible();
  });
});

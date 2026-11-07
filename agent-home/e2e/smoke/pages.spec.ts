import { asRole, expect, test } from "../support/fixtures";
import { component, expectPageReady, projects } from "../support/ui";

test.describe("key pages", { tag: "@smoke" }, () => {
  asRole("admin");

  test("settings loads", async ({ page }) => {
    await page.goto("/settings");
    await expectPageReady(page, "/settings");
    await page.locator('[data-section-link="account"]').click();
    await expect(page).toHaveURL(/\/settings\/account$/);
    await expect(component(page, "AccountSecurity")).toBeVisible();
  });

  test("profiles loads", async ({ page }) => {
    await page.goto("/profiles");
    await expectPageReady(page, "/profiles");
    await expect(component(page, "ProfilesView")).toBeVisible();
    await expect(component(page, "ProfileCard").first()).toBeVisible();
  });

  test("skills loads", async ({ page }) => {
    await page.goto("/skills");
    await expectPageReady(page, "/skills");
    await expect(component(page, "SkillsView")).toBeVisible();
  });

  test("a skill opens as a page and its editor keeps edits across views", async ({ page }) => {
    await page.goto("/skills");
    await expectPageReady(page, "/skills");
    const rows = component(page, "SkillRow");
    test.skip((await rows.count()) === 0, "no skills installed in the default profile");
    await rows.first().getByRole("link").first().click();
    await expect(component(page, "SkillPage")).toBeVisible();
    await expect(component(page, "SkillMarkdown")).toBeVisible();
    await page.getByRole("button", { name: "✎ Edit" }).or(page.getByRole("link", { name: "✎ Edit" })).first().click();
    const editor = component(page, "SkillEditor");
    await expect(editor).toHaveAttribute("data-view", "structured");
    const instructions = page.getByLabel("Instructions (Markdown)");
    await instructions.press("End");
    await instructions.pressSequentially("\n\ne2e marker line");
    await expect(component(page, "SkillSaveBar")).toBeVisible();
    await page.getByRole("button", { name: "Plain text" }).click();
    await expect(page.getByLabel("SKILL.md", { exact: true })).toHaveValue(/^---\n[\s\S]*e2e marker line/);
    await page.getByRole("button", { name: "Structured" }).click();
    await expect(instructions).toHaveValue(/e2e marker line/);
    await page.getByRole("button", { name: "Review & save" }).click();
    await expect(component(page, "SkillDiff").locator('[data-op="add"]').first()).toBeVisible();
    // Nothing is saved: keep editing, then discard.
    await page.getByRole("button", { name: "Keep editing" }).click();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(component(page, "SkillPage")).toBeVisible();
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

/**
 * Task mode on the Projects pages: the switch is on the list and on a
 * project page, the choice survives a reload per device class, a member
 * gets the Start box and a viewer does not, and a one-off project flips
 * between its Task and Project views in place. It never starts a task (that
 * would spend a model run); the create path is covered by the Python and
 * Vitest suites.
 */
import { asRole, expect, test } from "../support/fixtures";
import { component } from "../support/ui";

const switchRadio = (page: import("@playwright/test").Page, name: string) =>
  component(page, "ModeSwitch").getByRole("radio", { name });

test.describe("task mode — member", { tag: "@regression" }, () => {
  asRole("member");

  test("the switch flips the list and the choice sticks", async ({ page }) => {
    await page.goto("/projects?view=task");
    await expect(component(page, "TaskHome")).toBeVisible();
    await expect(page.getByPlaceholder("What should the agent do?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start task" })).toBeDisabled();
    await expect(page.getByLabel("Check in with me")).toHaveValue("supervised");

    await switchRadio(page, "Project mode").click();
    await expect(component(page, "ProjectsList")).toBeVisible();
    await expect(switchRadio(page, "Project mode")).toHaveAttribute("aria-checked", "true");

    await page.goto("/projects");
    await expect(component(page, "ProjectsList")).toBeVisible();

    await switchRadio(page, "Task mode").click();
    await expect(component(page, "TaskHome")).toBeVisible();
    await page.goto("/projects");
    await expect(component(page, "TaskHome")).toBeVisible();
  });

  test("a task opens in Task mode and flips to Project mode in place", async ({ page }) => {
    await page.goto("/projects?view=task");
    const first = component(page, "TaskRow").first();
    test.skip((await first.count()) === 0, "this member has no one-off projects");
    await first.locator("a").first().click();
    await expect(component(page, "TaskView")).toBeVisible();
    const url = page.url();
    await switchRadio(page, "Project mode").click();
    await expect(component(page, "ProjectDetailView")).toBeVisible();
    expect(page.url()).toBe(url);
  });
});

test.describe("task mode — viewer", { tag: "@regression" }, () => {
  asRole("viewer");

  test("a viewer sees tasks but no Start box", async ({ page }) => {
    await page.goto("/projects?view=task");
    await expect(component(page, "TaskHome")).toBeVisible();
    await expect(page.getByPlaceholder("What should the agent do?")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start task" })).toHaveCount(0);
  });
});

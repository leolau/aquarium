/**
 * A throwaway `[smoke]` project through its whole life: the wizard, the
 * readiness checklist, activate, a run, the run page, archive — and, on a
 * second never-run project, permanent delete (the server refuses to delete a
 * project with run history, so the run-through project stays archived).
 * afterAll sweeps every `[smoke]` project whatever happened.
 *
 * Activate / start-run selectors live in support/ui.ts (header buttons on
 * builds before the journey bar, #688; the bar's primary action after).
 */
import { smokeName, storageStatePath } from "../support/env";
import { sweepProjects } from "../support/cleanup";
import { asRole, desktopOnly, expect, test } from "../support/fixtures";
import { component, projects } from "../support/ui";

test.describe("project lifecycle", { tag: "@regression" }, () => {
  asRole("admin");
  desktopOnly();
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: storageStatePath("admin"),
    });
    await sweepProjects(ctx.request).finally(() => ctx.close());
  });

  test("wizard → readiness → activate → run → run page → archive", async ({ page }) => {
    test.setTimeout(360_000);
    const name = smokeName("lifecycle");

    await page.goto("/projects/new");
    const wizard = projects.wizard(page);
    await expect(wizard).toHaveAttribute("data-step", "1");
    await wizard.getByPlaceholder("Ship the Monday digest to every subscriber").fill(`${name} goal`);
    await wizard.getByPlaceholder(/A weekly digest compiled/).fill("Throwaway project created by the browser regression suite.");
    await wizard.getByPlaceholder("Monday digest", { exact: true }).fill(name);
    await wizard.getByPlaceholder("The Monday digest email").first().fill("A one-line smoke note");
    await wizard.getByRole("button", { name: "Next: inputs" }).click();

    await expect(wizard).toHaveAttribute("data-step", "2");
    await wizard.getByRole("button", { name: "I have no inputs — skip" }).click();
    await expect(wizard).toHaveAttribute("data-step", "3");
    await wizard.getByRole("button", { name: "Next: review" }).click();

    await expect(wizard).toHaveAttribute("data-step", "4");
    await wizard.locator('input[name="plan"][value="self"]').check();
    await wizard.getByRole("button", { name: "Create project", exact: true }).click();

    // `commit`: the project page keeps streams open, so `load` can lag.
    await page.waitForURL((url) => /^\/projects\/(?!new$)[^/]+$/.test(url.pathname), {
      timeout: 60_000,
      waitUntil: "commit",
    });
    const slug = decodeURIComponent(new URL(page.url()).pathname.split("/")[2]);
    await expect(projects.detail(page)).toBeVisible();
    await expect(component(page, "ProjectHeader")).toContainText(name);

    await test.step("readiness: missing plan, then ready once a plan is active", async () => {
      const checklist = projects.readiness(page).first();
      await expect(checklist).toBeVisible();
      await expect(checklist).toContainText("An active plan with steps");
      // Writing a plan step-by-step in the editor is its own UI; give the
      // project a one-step plan through the BFF, as the editor would.
      const base = `/api/projects/${encodeURIComponent(slug)}/playbook`;
      const saved = await page.request.post(base, {
        data: {
          body: "Smoke plan",
          steps: [{ key: "note", title: "Write a one-line smoke note", mode: "inline" }],
        },
      });
      expect(saved.ok(), `save plan: ${saved.status()}`).toBe(true);
      const { rev } = (await saved.json()) as { rev: number | { rev: number } };
      const revNo = typeof rev === "number" ? rev : rev.rev;
      const activated = await page.request.post(`${base}/${revNo}/activate`, { data: {} });
      expect(activated.ok(), `activate plan: ${activated.status()}`).toBe(true);
      await page.reload();
      await expect(projects.detail(page)).toBeVisible();
      // The plan line loses its "— fix it" link once satisfied.
      await expect(projects.readiness(page).first()).not.toContainText(/An active plan with steps\s*—/);
    });

    await test.step("activate", async () => {
      await expect(projects.activate(page)).toBeVisible();
      await projects.activate(page).click();
      await expect(projects.activate(page)).toHaveCount(0, { timeout: 30_000 });
    });

    await test.step("run and view the run", async () => {
      await expect(projects.runNow(page)).toBeEnabled();
      // Starting a run waits on the agent's first turn ("Talking to the
      // agent…"), which can take a couple of minutes on a busy box.
      const started = page.waitForResponse(
        (res) => res.request().method() === "POST" && new URL(res.url()).pathname === `/api/projects/${encodeURIComponent(slug)}/runs`,
        { timeout: 240_000 },
      );
      await projects.runNow(page).click();
      const res = await started;
      expect(res.ok(), `start run: ${res.status()}`).toBe(true);
      const data = (await res.json()) as { run?: { run_no?: number }; run_no?: number };
      const runNo = data.run?.run_no ?? data.run_no;
      expect(typeof runNo, "run_no in the start-run answer").toBe("number");
      // The header's Run now lands on the run page; the journey bar stays put
      // and links the run instead — open it either way.
      const runPath = `/projects/${encodeURIComponent(slug)}/runs/${runNo}`;
      await page
        .waitForURL((url) => url.pathname === runPath, { timeout: 15_000, waitUntil: "commit" })
        .catch(() => page.goto(runPath));
      await expect(projects.runView(page)).toBeVisible();
    });

    await test.step("stop the run (an open run blocks archiving)", async () => {
      await page.goto(`/projects/${encodeURIComponent(slug)}`);
      await expect(projects.detail(page)).toBeVisible();
      const stopAll = page.getByRole("button", { name: /Stop all/ });
      if (await stopAll.isVisible()) {
        await stopAll.click();
        const dialog = component(page, "StopAllDialog");
        await dialog.locator('input[name="stop-mode"][value="now"]').check();
        await dialog.getByRole("button", { name: /^Stop run \d+/ }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });
      }
    });

    await test.step("archive", async () => {
      // The run closes asynchronously after a stop: retry until the server
      // stops reporting an open run.
      await expect(async () => {
        await page.goto(`/projects/${encodeURIComponent(slug)}`);
        await expect(projects.detail(page)).toBeVisible();
        const archivedNote = page.getByText("This project is archived —");
        if (await archivedNote.isVisible()) return;
        await projects.lifecycleMenu(page).click();
        await page.getByRole("button", { name: "Archive project…" }).click();
        const dialog = component(page, "ArchiveDialog");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Archive", exact: true }).click();
        await expect(archivedNote).toBeVisible({ timeout: 15_000 });
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    });
  });

  test("a never-run archived project can be deleted permanently", async ({ page }) => {
    const name = smokeName("delete");
    await page.goto("/projects");
    const created = await page.request.post("/api/projects", {
      data: {
        name,
        goal: `${name} goal`,
        description: "Throwaway project created by the browser regression suite.",
        outputs: [{ title: "A one-line smoke note" }],
        host_profile: "default",
      },
    });
    expect(created.ok(), `create: ${created.status()}`).toBe(true);
    const { slug } = (await created.json()) as { slug: string };
    const archived = await page.request.post(`/api/projects/${encodeURIComponent(slug)}/archive`, {
      data: { reason: "e2e" },
    });
    expect(archived.ok()).toBe(true);

    await page.goto(`/projects/${encodeURIComponent(slug)}`);
    await projects.lifecycleMenu(page).click();
    await page.getByRole("button", { name: "Delete permanently…" }).click();
    const dialog = component(page, "DeleteDialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox").fill(slug);
    await dialog.getByRole("button", { name: "Delete forever" }).click();
    await page.waitForURL((url) => url.pathname === "/projects", { waitUntil: "commit" });
    const gone = await page.request.get(`/api/projects/${encodeURIComponent(slug)}`);
    expect(gone.status()).toBe(404);
  });
});

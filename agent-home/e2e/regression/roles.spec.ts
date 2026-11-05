/**
 * Role isolation, checked against the BFF's own route classification
 * (src/lib/auth/route-roles.json): every parameter-free admin/owner GET must
 * refuse a member or viewer, and the Users page must not offer them member
 * management. Only GETs are probed — nothing is changed.
 */
import routeRoles from "../../src/lib/auth/route-roles.json" with { type: "json" };

import type { Role } from "../support/env";
import { asRole, expect, test } from "../support/fixtures";
import { component, expectPageReady } from "../support/ui";

const guardedGets = (levels: string[]) =>
  Object.entries(routeRoles as Record<string, string>)
    .filter(([key, level]) => key.startsWith("GET ") && !key.includes("[") && levels.includes(level))
    .map(([key]) => key.slice(4));

for (const role of ["member", "viewer"] as Role[]) {
  test.describe(`${role} cannot reach admin surfaces`, { tag: "@regression" }, () => {
    asRole(role);

    test("admin/owner API routes refuse", async ({ page }) => {
      await page.goto("/");
      for (const path of guardedGets(["admin", "owner"])) {
        const res = await page.request.get(path);
        expect.soft(res.status(), `GET ${path}`).toBe(403);
      }
    });

    for (const path of ["/profiles", "/skills", "/skills/zz-e2e-skill", "/skills/zz-e2e-skill/edit"]) {
      test(`${path} is not available`, async ({ page }) => {
        await page.goto(path);
        await expect(component(page, "NotAvailableForRole")).toBeVisible();
        await expect(component(page, path === "/profiles" ? "ProfilesView" : "SkillsView")).toHaveCount(0);
      });
    }

    test("users page shows the directory but no member management", async ({ page }) => {
      await page.goto("/users");
      await expectPageReady(page, "/users");
      await expect(component(page, "CreateUserForm")).toHaveCount(0);
      await expect(component(page, "CsvImportPanel")).toHaveCount(0);
    });
  });
}

test.describe("admin reaches admin surfaces", { tag: "@regression" }, () => {
  asRole("admin");

  test("admin API routes answer", async ({ page }) => {
    await page.goto("/");
    for (const path of guardedGets(["admin"])) {
      const res = await page.request.get(path);
      expect.soft(res.status(), `GET ${path}`).not.toBe(403);
      expect.soft(res.status(), `GET ${path}`).toBeLessThan(500);
    }
  });

  test("users page offers member management", async ({ page }) => {
    await page.goto("/users");
    await expectPageReady(page, "/users");
    await expect(component(page, "CreateUserForm")).toBeVisible();
  });
});

/**
 * Playwright browser E2E for agent-home (`e2e/`). Deliberately separate from
 * Vitest (`npm test` only includes `src/**`): these specs drive a real,
 * running agent-home, usually production over an SSH tunnel. See
 * docs/testing/e2e.md.
 *
 *   E2E_BASE_URL   where agent-home is served (default http://localhost:3100)
 *   SMOKE_{ADMIN,MEMBER,VIEWER}_{EMAIL,PASSWORD}  test accounts; a spec that
 *                  needs a role whose credentials are missing skips itself.
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Production is shared with real users (and a small DB pool): one worker.
  workers: Number(process.env.E2E_WORKERS || 1),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: Number(process.env.E2E_RETRIES || 0),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "phone",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});

/**
 * Every selector the specs share lives here so a UI change (the menu's
 * per-role visibility, the project journey bar, the chat filter panel, the
 * activity bar) is a one-file update. Prefer roles/labels and the existing
 * `data-component` / `data-action` hooks.
 */
import { expect, type Locator, type Page } from "@playwright/test";

import { LOGIN_PROVIDER, type Credentials } from "./env";

export const component = (page: Page | Locator, name: string): Locator =>
  page.locator(`[data-component="${name}"]`);

/**
 * The stable marker each Coral destination renders once its data loaded.
 * A route missing here (a new menu item) still gets the generic checks: the
 * shell, its title and no page-level error panel.
 */
export const PAGE_MARKERS: Record<string, string> = {
  "/": "LandingLayout",
  "/profiles": "ProfilesView",
  "/skills": "SkillsView",
  "/todos": "TodosList",
  "/chat": "ChatPane",
  "/inbox": "InboxView",
  "/memory": "MemoryView",
  // Present in both project and task mode; the mode is saved per device.
  "/projects": "ProjectsModeView",
  "/files": "FilesView",
  "/files/browse": "BrowseView",
  "/activity": "TraceTimeline",
  "/graph": "GtsCentreView",
  "/capacity": "CapacityView",
  "/users": "UsersView",
  "/profiles/suggestions": "ProfileSuggestionsView",
  "/tools": "ToolsRegistry",
  "/models": "ModelsView",
  "/core": "CoreAreaView",
  "/webview": "WebviewConsole",
  "/settings": "SettingsView",
  "/onboarding": "OnboardingWizard",
};

/**
 * Page-level failure panels (`ChatError`, `ProjectsPageError`, …). Inline
 * `ActionError`s only render after a failed click, so they are not excluded
 * by accident: none should be visible on a fresh page either.
 */
export const pageErrorPanels = (page: Page): Locator =>
  page.locator('main [data-component$="Error"]');

/** The page's `<h1>` title in the shell header. */
export const pageTitle = (page: Page): Locator =>
  component(page, "MobileShell").locator("header h1");

/** Assert the shell rendered, with its marker and no error panel. */
export async function expectPageReady(page: Page, route: string): Promise<void> {
  // `.last()`: a route's loading skeleton renders its own shell until the
  // page streams in.
  const shell = component(page, "MobileShell").last();
  await expect(shell).toBeVisible();
  // A bare shell (the landing page) draws its own top bar, with no title.
  if ((await shell.getAttribute("data-variant")) !== "bare") {
    await expect(pageTitle(page).last()).not.toBeEmpty();
  }
  const marker = PAGE_MARKERS[route];
  if (marker) {
    await expect(component(page, marker).first()).toBeVisible();
  }
  await expect(pageErrorPanels(page)).toHaveCount(0);
}

// ── Coral menu ───────────────────────────────────────────────────────────

export const coralFab = (page: Page): Locator =>
  component(page, "CoralHost").locator("button[aria-controls], button[aria-expanded]").last();

export const coralMenu = (page: Page): Locator =>
  page.locator("#coral-panel[role='menu']");

export async function openCoral(page: Page): Promise<Locator> {
  const menu = coralMenu(page);
  if (!(await menu.isVisible())) {
    await coralFab(page).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

/** The routes of every item the signed-in role sees in the Coral menu. */
export async function coralRoutes(page: Page): Promise<string[]> {
  const menu = await openCoral(page);
  const hrefs = await menu
    .getByRole("menuitem")
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  await coralFab(page).click();
  await expect(menu).toBeHidden();
  return [...new Set(hrefs.filter((h) => h.startsWith("/")))];
}

// ── Login / logout ───────────────────────────────────────────────────────

export async function fillLogin(page: Page, creds: Credentials): Promise<void> {
  const form = component(page, "LoginForm");
  await expect(form).toBeVisible();
  const provider = form.locator("select");
  if (await provider.count()) {
    await provider.selectOption(LOGIN_PROVIDER);
  }
  await form.locator('input[autocomplete="username"], input[autocomplete="email"]').fill(creds.email);
  await form.locator('input[autocomplete="current-password"]').fill(creds.password);
  await form.locator('button[type="submit"]').click();
}

export async function login(page: Page, creds: Credentials): Promise<void> {
  await page.goto("/login");
  await fillLogin(page, creds);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

// ── Status strip ─────────────────────────────────────────────────────────

/** The landing top bar's health pill: a bar on desktop, a dot on phones. */
export const healthPill = (page: Page): Locator =>
  page.locator('[data-component="HealthPill"]:visible').first();
/** Opens the health readings (desktop popover or phone sheet). */
export async function openHealthReadings(page: Page): Promise<Locator> {
  await page
    .locator('[data-component="HealthPill"][data-variant="compact"]:visible, [data-action="health-open"]:visible')
    .first()
    .click();
  const readings = component(page, "HealthReadings").last();
  await expect(readings).toBeVisible();
  return readings;
}
export const statusRefresh = (readings: Locator): Locator =>
  readings.locator('[data-action="status-refresh"]');

// ── Chat ─────────────────────────────────────────────────────────────────

export const chat = {
  newButton: (page: Page) => page.getByRole("button", { name: "New conversation" }),
  composer: (page: Page) => component(page, "Composer").locator("textarea"),
  send: (page: Page) => component(page, "Composer").getByRole("button", { name: "Send" }),
  thread: (page: Page) => component(page, "ChatThread"),
  /** The streaming reply, or the settled assistant bubble once it finished. */
  replyStarted: (page: Page) =>
    page.locator(
      '[data-component="LiveReply"], [data-component="LiveActivity"], [data-component="MessageBubble"][data-role="assistant"], [data-component="MessageBubble"].justify-start',
    ),
  activeChip: (page: Page) =>
    component(page, "SessionTabs").getByRole("button", { name: /^Edit conversation/ }),
  modal: (page: Page) => component(page, "SessionModal"),
};

// ── Projects ─────────────────────────────────────────────────────────────

export const projects = {
  list: (page: Page) => component(page, "ProjectsList"),
  /** Links to individual project pages (not "new", not runs/cards). */
  projectLinks: (page: Page) =>
    component(page, "ProjectsList").locator(
      'a[href^="/projects/"]:not([href="/projects/new"]):not([href*="/runs/"]):not([href*="/cards/"])',
    ),
  detail: (page: Page) => component(page, "ProjectDetailView"),
  wizard: (page: Page) => component(page, "NewProjectForm"),
  readiness: (page: Page) => component(page, "ReadinessChecklist"),
  // The journey bar (#688) replaced the header's `data-action` buttons with
  // its primary action; both forms are matched until every box runs #688.
  activate: (page: Page) =>
    page
      .locator('[data-action="activate"]')
      .or(component(page, "JourneyBar").getByRole("button", { name: /^Activate\b/ }))
      .first(),
  runNow: (page: Page) =>
    page
      .locator('[data-action="run-now"]')
      .or(component(page, "JourneyBar").getByRole("button", { name: /^Start iteration \d+/ }))
      .first(),
  lifecycleMenu: (page: Page) => page.getByRole("button", { name: "Project actions" }),
  runView: (page: Page) => component(page, "RunView"),
};

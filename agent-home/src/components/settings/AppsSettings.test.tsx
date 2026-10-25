// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppsSettings } from "@/components/settings/AppsSettings";
import { APPS_SETTINGS_MESSAGES } from "@/components/settings/appsSettingsStrings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tier = (running: number) => ({
  per_app: { memory_high_mb: 384, memory_max_mb: 512, cpu_quota_pct: 50, disk_mb: 1536, db_mb: 500, db_connections: 5 },
  per_member: { apps_registered: 3, apps_running: running, ram_mb: 1024, disk_mb: 4096, db_mb: 1024, external_apps: 5 },
});

type Call = { url: string; method: string; body: unknown };

function mockApi(opts: { adminEditable?: boolean; tokenSet?: boolean } = {}) {
  const calls: Call[] = [];
  const github = {
    owner: "acme",
    use_box_git: false,
    mode: opts.tokenSet ? "token" : "local-only",
    token: opts.tokenSet ? { set: true, last4: "9xyz" } : { set: false, last4: null },
  };
  const limits = {
    tiers: { member: tier(2), admin: tier(4) },
    defaults: { member: tier(2), admin: tier(4) },
    editable: { member: true, admin: opts.adminEditable ?? true },
  };
  const storage = { base_path: "/var/lib/aquarium-apps", min_free_mb: 2048, free_mb: 51200 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const data = url.endsWith("/limits") ? limits : url.endsWith("/storage") ? storage : github;
    const answer =
      method === "PUT" && url.endsWith("/github")
        ? { ...github, mode: "token", token: { set: true, last4: "1234" } }
        : data;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("AppsSettings", () => {
  it("shows the three panels with the decision-8 defaults and the free space", async () => {
    mockApi();
    render(<AppsSettings />);
    expect(await screen.findByDisplayValue("/var/lib/aquarium-apps")).toBeTruthy();
    expect(screen.getByText(/Free now: 51200 MB/)).toBeTruthy();
    const running = (await screen.findByLabelText(/Apps running at once/, { selector: "#apps-limit-member-per_member-apps_running" })) as HTMLInputElement;
    expect(running.value).toBe("2");
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.getByText("Source stays in local git only.")).toBeTruthy();
  });

  it("saves one tier through the project action, sending only that tier", async () => {
    const calls = mockApi();
    render(<AppsSettings />);
    const input = (await screen.findByLabelText(/Apps running at once/, { selector: "#apps-limit-member-per_member-apps_running" })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(document.querySelector('[data-action="save-limits-member"]')!);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/settings/apps/limits");
    const body = put.body as { limits: Record<string, ReturnType<typeof tier>> };
    expect(Object.keys(body.limits)).toEqual(["member"]);
    expect(body.limits.member.per_member.apps_running).toBe(1);
  });

  it("locks the admins' tier when the server says it is not editable (admin viewer)", async () => {
    mockApi({ adminEditable: false });
    render(<AppsSettings />);
    expect(await screen.findByText("Only the owner can change the admins' limits.")).toBeTruthy();
    const fieldset = document.querySelector('fieldset[data-tier="admin"]') as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
    expect(document.querySelector('[data-action="save-limits-admin"]')).toBeNull();
  });

  it("sends a new token write-only, clears the field and shows only the last 4", async () => {
    const calls = mockApi();
    render(<AppsSettings />);
    const token = (await screen.findByPlaceholderText("Paste a new token to replace")) as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "ghp_newtoken00001234" } });
    const save = document.querySelector('[data-action="save-github"]') as HTMLButtonElement;
    expect(save.closest("[data-appmcp-deny]")).toBeTruthy();
    fireEvent.click(save);
    expect(await screen.findByText("Set (ends in 1234)")).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put).toMatchObject({ url: "/api/settings/apps/github", body: { token: "ghp_newtoken00001234" } });
    const fresh = screen.getByPlaceholderText("Paste a new token to replace") as HTMLInputElement;
    expect(fresh.value).toBe("");
    expect(document.body.textContent).not.toContain("ghp_newtoken");
  });

  it("offers forgetting a set token behind data-appmcp-deny", async () => {
    mockApi({ tokenSet: true });
    render(<AppsSettings />);
    expect(await screen.findByText("Set (ends in 9xyz)")).toBeTruthy();
    const remove = document.querySelector('[data-action="remove-github-token"]') as HTMLElement;
    expect(remove.getAttribute("data-appmcp-deny")).toBe("consent");
  });

  it("has a 繁中 string for every English one", () => {
    const en = APPS_SETTINGS_MESSAGES.en;
    const zh = APPS_SETTINGS_MESSAGES["zh-Hant"];
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zh[key].trim(), key).not.toBe("");
      expect([...zh[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]), key).toEqual(
        [...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      );
    }
  });
});

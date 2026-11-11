// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/sites/s1" }));

import { AddSiteForm, toSiteInput } from "@/components/sites/AddSiteForm";
import { DataTab, exportUrl, rowsUrl } from "@/components/sites/DataTab";
import { DesignTab } from "@/components/sites/DesignTab";
import { SharingTab } from "@/components/sites/SharingTab";
import { SiteDetail } from "@/components/sites/SiteDetail";
import { SitesList } from "@/components/sites/SitesList";
import type { DirectoryEntry } from "@/types";
import type { SiteDesign, SiteSource, SiteTable } from "@/types/sites";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.values(router).forEach((f) => f.mockReset());
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function site(over: Partial<SiteSource> = {}): SiteSource {
  return {
    id: "s1",
    slug: "hsdos_wms",
    name: "HSDOS WMS",
    base_url: "https://wms.example.com",
    login_url: "https://wms.example.com/login",
    login_saved: true,
    owner_user_id: "leo",
    profile: "default",
    status: "active",
    schema_name: "site_hsdos_wms",
    schedule_cron: "0 22 * * *",
    default_refresh_mode: "incremental",
    created_at: null,
    updated_at: null,
    access: "admin",
    design_version: 2,
    ...over,
  };
}

const PEOPLE: DirectoryEntry[] = [
  { user_id: "leo", display: "Leo Lau", role: "owner", channels: [] },
  { user_id: "ken", display: "Ken Wong", role: "member", channels: [] },
  { user_id: "amy", display: "Amy Chan", role: "member", channels: [] },
];

const PROPOSED: SiteDesign = {
  version: 3,
  status: "proposed",
  design: {
    entities: [
      {
        name: "rma_cases",
        kind: "variable",
        reason: "Cases open and close daily",
        key: ["rma_no"],
        columns: [{ name: "rma_no", type: "text", example: "RMA-2611-0042" }],
        refresh: { mode: "incremental", cursor: "updated_at" },
        question: "Keep closed RMAs older than a year?",
      },
    ],
  },
  proposed_by: "leo",
  proposed_at: null,
  approved_by: null,
  approved_at: null,
};

const TABLES: SiteTable[] = [
  { name: "rma_cases", kind: "variable", reason: "", key: ["rma_no"], columns: [], refresh: {}, rows: 2, removed: 1, last_seen: null },
];

describe("SitesList", () => {
  it("lists sites with owner and filters mine vs shared", () => {
    render(
      <SitesList
        me="ken"
        canCreate={false}
        people={{ leo: "Leo Lau" }}
        items={[
          { site: site({ access: "read" }), lastRun: null },
          { site: site({ id: "s2", slug: "ken_portal", name: "Ken portal", owner_user_id: "ken", schedule_cron: null }), lastRun: null },
        ]}
      />,
    );
    expect(screen.getByText("HSDOS WMS")).toBeTruthy();
    expect(screen.getByText("Leo Lau")).toBeTruthy();
    expect(screen.getByText("Manual only")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    expect(screen.queryByText("HSDOS WMS")).toBeNull();
    expect(screen.getByText("Ken portal")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Shared with me" }));
    expect(screen.getByText("HSDOS WMS")).toBeTruthy();
  });
});

describe("AddSiteForm", () => {
  it("sends only filled fields and keeps a half login out", () => {
    const base = { name: "", base_url: " https://wms.example.com ", login_url: "", username: "ops", password: "", schedule: { kind: "off" as const }, mode: "full" as const };
    expect(toSiteInput(base, 0)).toEqual({ base_url: "https://wms.example.com", default_refresh_mode: "full" });
    expect(toSiteInput({ ...base, password: "pw", schedule: { kind: "daily", time: "06:00" } }, -480)).toMatchObject({
      username: "ops",
      password: "pw",
      schedule_cron: "0 22 * * *",
    });
  });

  it("creates the site, shares it, then opens it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ site: site({ id: "new1" }) }))
      .mockResolvedValueOnce(json({ grant: { user_id: "ken", grant: "read" } }));
    render(<AddSiteForm people={PEOPLE} me="leo" />);
    fireEvent.change(screen.getByPlaceholderText("https://wms.example.com"), { target: { value: "https://wms.example.com" } });
    fireEvent.click(screen.getByLabelText(/Me and people I pick/));
    fireEvent.click(screen.getByLabelText("Ken Wong"));
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/sites/new1"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sites");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      base_url: "https://wms.example.com",
      default_refresh_mode: "incremental",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sites/new1/grants");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ user_id: "ken", grant: "read" });
  });
});

describe("DesignTab", () => {
  it("shows the agent's question and approves through the real route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ version: 3, status: "approved", statements: ["a", "b"] }));
    render(<DesignTab siteId="s1" designs={[PROPOSED]} canManage people={{}} />);
    expect(screen.getAllByText(/Keep closed RMAs older than a year\?/).length).toBeGreaterThan(0);
    expect(screen.getByText("Cases open and close daily")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/1 open question/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Design v3 approved")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/sites/s1/designs/3/approve", expect.objectContaining({ method: "POST" }));
  });

  it("has no Approve for read grantees", () => {
    render(<DesignTab siteId="s1" designs={[PROPOSED]} canManage={false} people={{}} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/You have read access/)).toBeTruthy();
  });
});

describe("DataTab", () => {
  it("builds row and export URLs for the BFF", () => {
    expect(rowsUrl("s1", "rma_cases", "IMEI 35", 2, true)).toBe(
      "/api/sites/s1/tables/rma_cases?page=2&page_size=50&q=IMEI+35&include_removed=true",
    );
    expect(exportUrl("s1", "rma_cases", "xlsx", false)).toBe("/api/sites/s1/tables/rma_cases/export?format=xlsx");
  });

  it("loads rows, shows removed ones on request and opens row history", async () => {
    const rows = {
      entity: "rma_cases",
      kind: "variable",
      columns: ["_key", "rma_no", "status", "_removed_at"],
      rows: [{ _key: "RMA-1", rma_no: "RMA-1", status: "open", _removed_at: null }],
      total: 1,
      page: 1,
      page_size: 50,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/history/")) {
        return json({
          entity: "rma_cases",
          key: "RMA-1",
          kind: "variable",
          changes: [{ op: "update", at: "2026-11-10T01:00:00Z", before: { status: "new" }, after: { status: "open" } }],
          versions: [],
        });
      }
      return json(rows);
    });
    render(<DataTab siteId="s1" tables={TABLES} />);
    await screen.findByText("open");
    fireEvent.click(screen.getByLabelText("Show removed rows"));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("include_removed=true"));
    expect(screen.getByText("Export CSV").getAttribute("href")).toBe(
      "/api/sites/s1/tables/rma_cases/export?format=csv&include_removed=true",
    );
    fireEvent.click(await screen.findByText("open"));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText("Changed");
    expect(within(sheet).getByText("new")).toBeTruthy();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("/api/sites/s1/history/rma_cases/RMA-1");
  });
});

describe("SharingTab", () => {
  it("grants and revokes through the grants route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ grant: { user_id: "amy", grant: "admin", granted_by: "leo", created_at: null } }))
      .mockResolvedValueOnce(json({ revoked: true }));
    render(
      <SharingTab
        siteId="s1"
        ownerId="leo"
        me="leo"
        directory={PEOPLE}
        grants={[{ user_id: "ken", grant: "read", granted_by: "leo", created_at: null }]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "amy" } });
    fireEvent.change(screen.getByLabelText("Access"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(screen.getByLabelText("Access for Amy Chan")).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ user_id: "amy", grant: "admin" });

    const ken = document.querySelector('[data-grant="ken"]') as HTMLElement;
    fireEvent.click(within(ken).getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(document.querySelector('[data-grant="ken"]')).toBeNull());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sites/s1/grants?user_id=ken");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });
});

describe("SiteDetail", () => {
  const props = { designs: [PROPOSED], tables: TABLES, runs: [], directory: PEOPLE, initialTab: "design" as const };

  it("hides Sharing and management for a read grantee", () => {
    render(<SiteDetail {...props} site={site({ access: "read" })} grants={null} me="ken" />);
    expect(screen.queryByRole("tab", { name: "Sharing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Schedule/ }));
    expect(screen.queryByRole("button", { name: "Save schedule" })).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/sites/s1?tab=schedule", { scroll: false });
  });

  it("lets an admin pause the site and save the schedule", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ site: site() }));
    render(<SiteDetail {...props} site={site()} grants={[]} me="leo" />);
    expect(screen.getByRole("tab", { name: "Sharing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sites/s1");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ status: "paused" });

    fireEvent.click(screen.getByRole("tab", { name: /Schedule/ }));
    fireEvent.change(screen.getByLabelText("Frequency"), { target: { value: "hours" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      schedule_cron: "0 */6 * * *",
      default_refresh_mode: "incremental",
    });
  });
});

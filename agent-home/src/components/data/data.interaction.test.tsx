// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/data/s1" }));

import { DataList } from "@/components/data/DataList";
import { DictionaryDetail } from "@/components/data/DictionaryDetail";
import { ReviewDraft } from "@/components/data/ReviewDraft";
import { fieldDiff, textToColumns } from "@/components/data/format";
import type { DataSource, DataSourceDoc, DictionaryEntry } from "@/types/data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.values(router).forEach((f) => f.mockReset());
});

const ENTRY: DictionaryEntry = { meaning: "Orders", row: "One order", grain: "order", columns: { amount: "HKD" }, joins: [], metrics: [], examples: [] };

function source(over: Partial<DataSource> = {}): DataSource {
  return { id: "s1", kind: "site", name: "Shop", owner_user_id: "leo", site_id: "x", access: "manage", status: "draft", approved_version: 1, tables_described: 1, draft_version: 2, draft_changes: 1, ...over };
}

function doc(access: DataSource["access"]): DataSourceDoc {
  return {
    source: source({ access }),
    approved: { version: 1, status: "approved", based_on: null, changes: [], proposed_by: "leo", proposed_at: null, approved_by: "leo", approved_at: null, entries: { tables: { orders: ENTRY }, glossary: [] } },
    draft: {
      version: 2, status: "draft", based_on: 1, proposed_by: "ken", proposed_at: null, approved_by: null, approved_at: null,
      changes: [{ table: "orders", origin: "chat", by: "ken", note: "refunds" }, { table: "lines", origin: "study", by: "ken", note: "" }],
      entries: { tables: { orders: { ...ENTRY, meaning: "Orders, refunds excluded" }, lines: { ...ENTRY, meaning: "Order lines" } }, glossary: [] },
      changed_tables: ["lines", "orders"],
    },
  };
}

describe("data pages", () => {
  it("links managers with a draft to review and others to the dictionary", () => {
    render(<DataList sources={[source(), source({ id: "s2", access: "read" })]} people={{ leo: "Leo" }} />);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/data/s1/review", "/data/s2"]);
  });

  it("approves the draft version without rejected tables, once", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((r) => (release = r)));
    render(<ReviewDraft doc={doc("manage")} directory={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    const approve = screen.getByRole("button", { name: "Approve v2" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ version: 2, reject: ["lines"] });
    release(new Response("{}", { status: 200 }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/data/s1"));
  });

  it("shows proposers the draft read-only", () => {
    render(<ReviewDraft doc={doc("propose")} directory={[]} />);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByText(/Only the owner or an admin/)).toBeTruthy();
  });

  it("hides edit, build and share from readers", () => {
    const d = doc("read");
    render(<DictionaryDetail doc={{ ...d, draft: undefined }} versions={[]} directory={[]} />);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Build dictionary" })).toBeNull();
    expect(screen.getAllByText("Orders").length).toBeGreaterThan(0);
  });

  it("parses columns and diffs fields", () => {
    expect(textToColumns("Amount: HKD\n\nstatus")).toEqual({ amount: "HKD", status: "" });
    expect(fieldDiff(ENTRY, { ...ENTRY, grain: "line" })).toEqual([{ field: "grain", from: "order", to: "line" }]);
  });
});

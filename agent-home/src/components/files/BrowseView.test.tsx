// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/files/browse",
}));

import { BrowseView, formatSize, previewKind, serverFileUrl } from "@/components/files/BrowseView";
import { takePendingAttachments } from "@/lib/chat/pending-attachments";
import type { BrowseEntry, BrowsePlace } from "@/types";

const PLACES: BrowsePlace[] = [
  { id: "net-jensen", kind: "network", name: "Jensen-New", vpn: "HSD", shared: false,
    trusted_for_import: false, mounted: true, error: null },
  { id: "workspace", kind: "workspace", name: "Workspace" },
];

function entry(over: Partial<BrowseEntry>): BrowseEntry {
  return { name: "a", path: "a", kind: "file", size: 10, modified_at: "2026-10-17T00:00:00Z", ...over };
}

const LISTINGS: Record<string, BrowseEntry[]> = {
  "net-jensen:": [
    entry({ name: "Offers", path: "Offers", kind: "directory", size: null }),
    entry({ name: "quote.zip", path: "quote.zip", size: 2048 }),
  ],
  "net-jensen:Offers": [entry({ name: "offer.pdf", path: "Offers/offer.pdf", size: 412 * 1024 })],
};

let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  calls = [];
  push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/browse/places") return Response.json({ places: PLACES });
      if (u.pathname === "/api/browse/list") {
        const key = `${u.searchParams.get("place")}:${u.searchParams.get("path")}`;
        return Response.json({ place: "x", path: "", entries: LISTINGS[key] ?? [], truncated: false });
      }
      if (u.pathname === "/api/browse/save") return Response.json({ ok: true, assetId: "f1" });
      if (u.pathname === "/api/browse/attach")
        return Response.json({ path: "mia/x/offer.pdf", name: "offer.pdf", content_type: "application/pdf", size: 3 });
      return new Response("nope", { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

async function openJensen() {
  render(<BrowseView />);
  const btn = await screen.findAllByRole("button", { name: /Jensen-New/ });
  fireEvent.click(btn[0]);
  await screen.findAllByText("Offers");
}

describe("BrowseView", () => {
  it("lists places by group and says computer folders need Chrome/Edge here", async () => {
    render(<BrowseView />);
    expect((await screen.findAllByText("Jensen-New")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Workspace").length).toBeGreaterThan(0);
    expect(screen.getByText(/work in Chrome or Edge/)).toBeTruthy();
    expect(screen.getByText("via HSD VPN · read-only")).toBeTruthy();
  });

  it("opens one level at a time, folders first", async () => {
    await openJensen();
    const lists = calls.filter((c) => c.url.startsWith("/api/browse/list"));
    expect(lists).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: /Offers/ })[0]);
    await screen.findAllByText("offer.pdf");
    expect(calls.filter((c) => c.url.startsWith("/api/browse/list")).map((c) => c.url)).toEqual([
      "/api/browse/list?place=net-jensen&path=",
      "/api/browse/list?place=net-jensen&path=Offers",
    ]);
  });

  it("asks before saving from a folder not trusted for import", async () => {
    await openJensen();
    fireEvent.click(screen.getAllByRole("button", { name: /quote\.zip/ })[0]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Save to my files" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.url === "/api/browse/save")).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(await screen.findByRole("button", { name: "Save to my files" }));
    await screen.findByText(/Saved to Files/);
    const save = calls.find((c) => c.url === "/api/browse/save");
    expect(JSON.parse(String(save?.init?.body))).toEqual({ place: "net-jensen", path: "quote.zip" });
  });

  it("'Ask the agent' attaches the file and opens chat with it pending", async () => {
    await openJensen();
    fireEvent.click(screen.getAllByRole("button", { name: /quote\.zip/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Ask the agent about this file" }));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(String(push.mock.calls[0][0])).toMatch(/^\/chat\?draft=/);
    expect(takePendingAttachments()).toEqual([
      { path: "mia/x/offer.pdf", name: "offer.pdf", content_type: "application/pdf", size: 3 },
    ]);
  });

  it("downloads through the BFF, never a raw path", async () => {
    await openJensen();
    fireEvent.click(screen.getAllByRole("button", { name: /quote\.zip/ })[0]);
    const link = await screen.findByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe(serverFileUrl("net-jensen", "quote.zip", true));
  });
});

describe("helpers", () => {
  it("formats sizes and picks a preview kind", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(previewKind("a.PNG")).toBe("image");
    expect(previewKind("notes.txt")).toBe("text");
    expect(previewKind("x.pdf")).toBe("pdf");
    expect(previewKind("x.xlsx")).toBe("none");
  });
});

describe("sorting and pages", () => {
  it("keeps folders first and sorts each column both ways", async () => {
    const { sortBrowse } = await import("@/components/files/BrowseView");
    const list = [
      entry({ name: "b.txt", path: "b.txt", size: 5, modified_at: "2026-01-02T00:00:00Z" }),
      entry({ name: "Zed", path: "Zed", kind: "directory", size: null }),
      entry({ name: "a10.txt", path: "a10.txt", size: 50, modified_at: "2026-01-01T00:00:00Z" }),
      entry({ name: "a9.txt", path: "a9.txt", size: 1, modified_at: "2026-01-03T00:00:00Z" }),
    ];
    const names = (k: "name" | "size" | "modified", d: "asc" | "desc") =>
      sortBrowse(list, k, d).map((e) => e.name);
    expect(names("name", "asc")).toEqual(["Zed", "a9.txt", "a10.txt", "b.txt"]);
    expect(names("name", "desc")).toEqual(["Zed", "b.txt", "a10.txt", "a9.txt"]);
    expect(names("size", "desc")).toEqual(["Zed", "a10.txt", "b.txt", "a9.txt"]);
    expect(names("modified", "desc")).toEqual(["Zed", "a9.txt", "b.txt", "a10.txt"]);
  });

  it("shows 50 rows a page and resorts from the column header", async () => {
    LISTINGS["net-jensen:"] = [
      entry({ name: "Offers", path: "Offers", kind: "directory", size: null }),
      ...Array.from({ length: 120 }, (_, i) =>
        entry({ name: `file-${String(i).padStart(3, "0")}.txt`, path: `f${i}`, size: i }),
      ),
    ];
    render(<BrowseView />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Jensen-New/ }))[0]);
    await screen.findByText(/Page 1 of 3/);
    expect(document.querySelectorAll("tr[data-entry]")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Page 2 of 3 · 51–100 of 121/)).toBeTruthy();
    fireEvent.click(document.querySelector('[data-sort="size"]') as HTMLElement);
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
    const rows = [...document.querySelectorAll("tr[data-entry]")].map((r) => r.getAttribute("data-entry"));
    expect(rows.slice(0, 2)).toEqual(["Offers", "f119"]);
  });
});

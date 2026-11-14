// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import { I18nProvider } from "@/i18n";
import zhNeedsYou from "@/i18n/messages/zh-Hant/needsYou.json";

import { NeedsYouItem, primaryAction } from "./NeedsYouItem";
import { fmtAge } from "./format";
import { needsYouEntry } from "./fixtures";

const NOW = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const oneTap = () =>
  needsYouEntry({
    id: "ny-todo",
    source: "todo",
    severity: "review",
    title: "Mark “Send invoice” done?",
    reversible: true,
    actions: [
      { id: "done", label: "Mark done", style: "primary", method: "POST", endpoint: "/api/todos/t1/done", body: { done: true } },
      { id: "open", label: "Open", style: "secondary", href: "/todos" },
    ],
  });

describe("fmtAge", () => {
  it("is short and never negative", () => {
    const s = NOW / 1000;
    expect(fmtAge(s + 30, NOW)).toBe("just now");
    expect(fmtAge(s - 8 * 60, NOW)).toBe("8 min");
    expect(fmtAge(s - 90 * 60, NOW)).toBe("1 h");
    expect(fmtAge(s - 3 * 86_400, NOW)).toBe("3 d");
  });
});

describe("primaryAction", () => {
  it("is one-tap only for reversible entries with a BFF endpoint", () => {
    expect(primaryAction(oneTap()).kind).toBe("one-tap");
    expect(primaryAction({ ...oneTap(), reversible: false })).toEqual({
      kind: "link",
      label: "Mark done…",
      href: "/projects/website-relaunch/runs/4",
    });
    expect(primaryAction({ ...oneTap(), reversible: undefined }).kind).toBe("link");
  });

  it("never posts to another origin or outside /api", () => {
    for (const endpoint of ["https://evil.example/api/x", "//evil.example/api", "/projects/x", "/api/../x"]) {
      const e = oneTap();
      e.actions[0] = { ...e.actions[0], endpoint };
      expect(primaryAction(e).kind).toBe("link");
    }
  });

  it("uses the action's own href, else the entry's, else Open", () => {
    expect(primaryAction(needsYouEntry())).toMatchObject({ label: "Review", href: "/projects/website-relaunch/runs/4" });
    expect(primaryAction(needsYouEntry({ actions: [] }))).toEqual({
      kind: "link",
      label: "Open",
      href: "/projects/website-relaunch/runs/4",
    });
  });
});

describe("NeedsYouItem", () => {
  it("shows title, source · age and a link action for a non-reversible entry", () => {
    render(<ul><NeedsYouItem entry={needsYouEntry()} now={NOW} /></ul>);
    expect(screen.getByTestId("needs-you-title").textContent).toBe("Run 4 is waiting at a checkpoint");
    expect(screen.getByTestId("needs-you-source").textContent).toBe("Website relaunch · 8 min");
    const link = screen.getByRole("link", { name: "Review" });
    expect(link.getAttribute("href")).toBe("/projects/website-relaunch/runs/4");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks new entries", () => {
    const { container } = render(<ul><NeedsYouItem entry={needsYouEntry()} now={NOW} isNew /></ul>);
    expect(container.querySelector("[data-new]")).not.toBeNull();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("one-tap posts once with an Idempotency-Key, shows a pending label, then Done", async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((r) => (resolve = r)),
    );
    const onActed = vi.fn();
    render(<ul><NeedsYouItem entry={oneTap()} now={NOW} onActed={onActed} /></ul>);
    const button = screen.getByRole("button", { name: "Mark done" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/todos/t1/done");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBeTruthy();
    expect(init?.body).toBe(JSON.stringify({ done: true }));
    await waitFor(() => expect(screen.getByText("Working…")).toBeTruthy());
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
    expect(onActed).toHaveBeenCalledOnce();
  });

  it("a failed one-tap offers Try again with the same key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "nope" }), { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const onActed = vi.fn();
    render(<ul><NeedsYouItem entry={oneTap()} now={NOW} onActed={onActed} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onActed).toHaveBeenCalledOnce());
    const key = (n: number) =>
      (fetchSpy.mock.calls[n][1]?.headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    expect(key(1)).toBe(key(0));
  });
});

describe("NeedsYouItem in zh-Hant", () => {
  it("renders the translated title, detail, age and action", () => {
    const entry = needsYouEntry({
      id: "data_draft:s1:4",
      source: "data_draft",
      severity: "review",
      title: "Dictionary draft v4 for WMS is ready",
      detail: "3 changes · from a chat",
      created_at: NOW / 1000 - 8 * 60,
      href: "/data/s1/review",
      actions: [{ id: "open", label: "Review", style: "primary", href: "/data/s1/review" }],
      i18n: {
        title: [{ key: "titles.dataDraft", vars: { v: 4, source: "WMS" } }],
        detail: [{ key: "details.changes", vars: { n: 3 } }, { key: "details.origin.chat" }],
      },
    });
    render(
      <I18nProvider locale="zh-Hant" messages={{ needsYou: zhNeedsYou }}>
        <NeedsYouItem entry={entry} now={NOW} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("needs-you-title").textContent).toBe("WMS 的字典草稿 v4 可以審閱了");
    expect(screen.getByTestId("needs-you-source").textContent).toBe("3 項修改 · 來自對話 · 8 分鐘");
    expect(screen.getByText("審閱")).toBeTruthy();
  });

  it("falls back to the server text when a key is unknown", () => {
    const entry = needsYouEntry({
      title: "Something new",
      i18n: { title: [{ key: "titles.notAKey" }] },
    });
    render(
      <I18nProvider locale="zh-Hant" messages={{ needsYou: zhNeedsYou }}>
        <NeedsYouItem entry={entry} now={NOW} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("needs-you-title").textContent).toBe("Something new");
  });
});

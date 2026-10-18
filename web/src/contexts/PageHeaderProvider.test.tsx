// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageHeaderProvider } from "./PageHeaderProvider";
import { usePageHeader } from "./usePageHeader";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: {} }) }));
vi.mock("@/lib/resolve-page-title", () => ({ resolvePageTitle: () => "Title" }));

function SetsEndOnMount({ label }: { label: string }) {
  const { setEnd } = usePageHeader();
  useLayoutEffect(() => {
    setEnd(<button>{label}</button>);
    return () => setEnd(null);
  }, [setEnd, label]);
  return null;
}

const nav: { go: (to: string) => void } = { go: () => {} };
function Nav() {
  const navigate = useNavigate();
  useLayoutEffect(() => {
    nav.go = navigate;
  }, [navigate]);
  return null;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <PageHeaderProvider pluginTabs={[]}>
        <Routes>
          <Route path="/mcp" element={<SetsEndOnMount label="Add Server" />} />
          <Route path="/cron" element={<SetsEndOnMount label="Create" />} />
          <Route path="/plain" element={null} />
        </Routes>
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("PageHeaderProvider", () => {
  it("keeps a header button a page sets on its first mount (hard reload)", () => {
    renderAt("/mcp");
    expect(screen.queryByText("Add Server")).not.toBeNull();
  });

  it("swaps the button on navigation and clears it on pages without one", () => {
    renderAt("/mcp");
    act(() => nav.go("/cron"));
    expect(screen.queryByText("Add Server")).toBeNull();
    expect(screen.queryByText("Create")).not.toBeNull();
    act(() => nav.go("/plain"));
    expect(screen.queryByText("Create")).toBeNull();
  });
});

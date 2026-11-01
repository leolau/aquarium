// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatFiltersPanel } from "@/components/chat/ChatFiltersPanel";

afterEach(cleanup);

function renderPanel(props: Partial<Parameters<typeof ChatFiltersPanel>[0]> = {}) {
  return render(
    <ChatFiltersPanel
      open={false}
      onToggle={() => {}}
      profile="work"
      filterCount={0}
      searchActive={false}
      {...props}
    >
      <input aria-label="inside" />
    </ChatFiltersPanel>,
  );
}

describe("ChatFiltersPanel", () => {
  it("collapsed: hides the controls but keeps them mounted, wired via aria-controls", () => {
    renderPanel();
    const toggle = screen.getByRole("button", { name: /Filters & search/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(true);
    expect(panel!.querySelector("input")).not.toBeNull();
    expect(screen.getByTestId("chat-filters-profile").textContent).toContain("work");
  });

  it("expanded: shows the controls", () => {
    renderPanel({ open: true });
    const toggle = screen.getByRole("button", { name: /Filters & search/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Filters and search" }).hidden).toBe(false);
  });

  it("calls onToggle when the toggle is pressed", () => {
    const onToggle = vi.fn();
    renderPanel({ onToggle });
    fireEvent.click(screen.getByRole("button", { name: /Filters & search/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("badges the active filter count, singular and plural", () => {
    const { rerender } = renderPanel();
    expect(screen.queryByTestId("chat-filters-badge")).toBeNull();
    rerender(
      <ChatFiltersPanel open={false} onToggle={() => {}} profile="work" filterCount={1} searchActive={false}>
        {null}
      </ChatFiltersPanel>,
    );
    expect(screen.getByTestId("chat-filters-badge").textContent).toBe("1 filter");
    rerender(
      <ChatFiltersPanel open={false} onToggle={() => {}} profile="work" filterCount={2} searchActive={false}>
        {null}
      </ChatFiltersPanel>,
    );
    expect(screen.getByTestId("chat-filters-badge").textContent).toBe("2 filters");
  });

  it("flags an active search only while collapsed", () => {
    const { rerender } = renderPanel({ searchActive: true });
    expect(screen.getByTestId("chat-filters-search")).not.toBeNull();
    rerender(
      <ChatFiltersPanel open onToggle={() => {}} profile="work" filterCount={0} searchActive>
        {null}
      </ChatFiltersPanel>,
    );
    expect(screen.queryByTestId("chat-filters-search")).toBeNull();
  });
});

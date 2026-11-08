// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionBanner } from "./AttentionBanner";
import { MOCK_NEEDS_YOU, MOCK_NOW, mockEntry } from "./mockData";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("AttentionBanner", () => {
  it("renders nothing when nothing needs you", () => {
    const { container } = render(<AttentionBanner items={[]} count={0} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the total and the most urgent item with its primary link action", () => {
    const onSeeAll = vi.fn();
    render(
      <AttentionBanner items={[...MOCK_NEEDS_YOU].reverse()} count={3} onSeeAll={onSeeAll} now={MOCK_NOW} />,
    );
    expect(screen.getByText("3 things need you")).toBeTruthy();
    expect(screen.getByText(MOCK_NEEDS_YOU[0].title)).toBeTruthy();
    const primary = screen.getByRole("link", { name: "Answer" });
    expect(primary.getAttribute("href")).toBe("/chat?session=s1");
    fireEvent.click(screen.getByText("See all"));
    expect(onSeeAll).toHaveBeenCalledOnce();
  });

  it("never offers a one-tap write: POST-only actions fall back to opening the item", () => {
    const entry = mockEntry({ actions: [{ id: "a", label: "Approve", style: "primary", method: "POST", endpoint: "/x" }] });
    render(<AttentionBanner items={[entry]} count={1} />);
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(entry.href);
  });

  it("collapses but cannot be dismissed while something is blocking", () => {
    render(<AttentionBanner items={MOCK_NEEDS_YOU} count={3} />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
    fireEvent.click(screen.getByLabelText("Collapse"));
    expect(screen.queryByText(MOCK_NEEDS_YOU[0].title)).toBeNull();
    expect(screen.getByText("3 things need you")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Expand"));
    expect(screen.getByText(MOCK_NEEDS_YOU[0].title)).toBeTruthy();
  });

  it("can be dismissed when nothing blocks, until a different item is most urgent", () => {
    const nonBlocking = MOCK_NEEDS_YOU.slice(1);
    const { rerender, container } = render(<AttentionBanner items={nonBlocking} count={2} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(container.innerHTML).toBe("");
    const newer = mockEntry({ id: "approval:new", created_at: 1 });
    rerender(<AttentionBanner items={[newer, ...nonBlocking]} count={3} />);
    expect(screen.getByText(newer.title)).toBeTruthy();
  });

  it("comes back if a blocking item arrives after a dismissal", () => {
    const nonBlocking = MOCK_NEEDS_YOU.slice(1);
    const { rerender } = render(<AttentionBanner items={nonBlocking} count={2} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    rerender(<AttentionBanner items={nonBlocking} count={2} blocking={1} />);
    expect(screen.getByText("2 things need you")).toBeTruthy();
  });
});

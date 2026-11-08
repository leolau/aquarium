// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinSuggestionCard } from "../PinSuggestionCard";

const two = [
  { session_id: "a", title: "Debug flaky e2e test", reason: "stopped mid-way", last_active: 1 },
  { session_id: "b", title: "Onboarding email sequence", reason: "waiting on a decision", last_active: 1 },
];

describe("PinSuggestionCard", () => {
  afterEach(cleanup);

  it("offers to pin both suggested chats", () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(<PinSuggestionCard suggestions={two} onAccept={onAccept} onDismiss={onDismiss} />);
    expect(screen.getByText("2 unfinished chats worth pinning")).toBeTruthy();
    expect(screen.getByText(/“Debug flaky e2e test” and “Onboarding email sequence”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pin both/ }));
    expect(onAccept).toHaveBeenCalledWith(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledWith(["a", "b"]);
  });

  it("uses singular copy for one chat and renders nothing for none", () => {
    const { rerender, container } = render(
      <PinSuggestionCard suggestions={[two[0]]} onAccept={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText("1 unfinished chat worth pinning")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pin it/ })).toBeTruthy();
    rerender(<PinSuggestionCard suggestions={[]} onAccept={vi.fn()} onDismiss={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

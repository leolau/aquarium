// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveActivity } from "@/components/chat/LiveActivity";

describe("LiveActivity", () => {
  afterEach(cleanup);

  it("renders nothing without activity", () => {
    const { container } = render(<LiveActivity reasoning="" tools={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("maximizes into a full panel with every step and the full reasoning", () => {
    const reasoning = "line one\n".repeat(40) + "last line";
    render(
      <LiveActivity
        reasoning={reasoning}
        tools={[
          { id: "a", name: "terminal", done: true },
          { id: "b", name: "vision_analyze", done: false },
        ]}
      />,
    );
    expect(document.querySelector('[data-component="LiveActivityMaximized"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Maximize agent activity" }));
    const panel = document.querySelector('[data-component="LiveActivityMaximized"]')!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.textContent).toContain("terminal — done");
    expect(panel.textContent).toContain("vision_analyze — running…");
    const full = panel.querySelector('[data-component="LiveReasoningFull"]')!;
    expect(full.textContent).toBe(reasoning);
    expect(full.className).not.toContain("max-h-24");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector('[data-component="LiveActivityMaximized"]')).toBeNull();
  });
});

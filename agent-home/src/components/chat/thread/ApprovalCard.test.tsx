// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "@/components/chat/thread/ApprovalCard";
import type { ChatApprovalRequest } from "@/types";

const request: ChatApprovalRequest = {
  runId: "run-1",
  command: "rm -rf /tmp/x",
  description: "Dangerous command",
  choices: ["deny", "always", "once", "session"],
};

describe("ApprovalCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders inline (not a modal) with the command and choices in order", () => {
    const { container } = render(
      <ApprovalCard request={request} busy={false} onResolve={() => {}} />,
    );
    const card = container.querySelector('[data-component="ApprovalCard"]')!;
    expect(card.getAttribute("role")).toBe("group");
    expect(card.getAttribute("aria-modal")).toBeNull();
    const title = document.getElementById(card.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Approval needed");
    expect(card.querySelector("pre")?.textContent).toBe("rm -rf /tmp/x");
    expect(screen.getByText("Dangerous command")).toBeTruthy();
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual([
      "Approve",
      "Approve for this chat",
      "Always approve",
      "Deny",
    ]);
  });

  it("marks every choice as user-only for app-mcp (F17)", () => {
    render(<ApprovalCard request={request} busy={false} onResolve={() => {}} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.closest("[data-appmcp-deny]")).not.toBeNull();
    }
  });

  it("focuses the first choice and scrolls itself into view on mount", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<ApprovalCard request={request} busy={false} onResolve={() => {}} />);
    expect(document.activeElement?.textContent).toBe("Approve");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("reports the chosen option", () => {
    const onResolve = vi.fn();
    render(<ApprovalCard request={request} busy={false} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenCalledWith("deny");
  });

  it("disables the choices while the decision is submitting", () => {
    render(<ApprovalCard request={request} busy onResolve={() => {}} />);
    expect(screen.getByText("Submitting your decision…")).toBeTruthy();
    for (const b of screen.getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("falls back to the tool name when there is no command", () => {
    const { container } = render(
      <ApprovalCard
        request={{ runId: "r", toolName: "browser", choices: ["once", "deny"] }}
        busy={false}
        onResolve={() => {}}
      />,
    );
    expect(container.querySelector("pre")?.textContent).toBe("browser");
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

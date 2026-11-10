// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRow } from "../SessionRow";
import { NOW, sessions } from "./fixtures";

const [pinnedRow, , liveRow, untitledRow] = sessions;

function renderRow(props: Partial<Parameters<typeof SessionRow>[0]> = {}) {
  return render(
    <ul>
      <SessionRow
        session={untitledRow}
        href="/chat?session=x"
        profileLabel="Default"
        canPin
        now={NOW}
        {...props}
      />
    </ul>,
  );
}

describe("SessionRow", () => {
  afterEach(cleanup);

  it("shows an untitled chat's preview in muted italics", () => {
    renderRow();
    const title = screen.getByText("can you check why the nightly sync failed");
    expect(title.getAttribute("data-slot")).toBe("session-title");
    expect(title.className).toContain("italic");
    expect(title.className).toContain("var(--color-muted)");
    expect(screen.getByRole("link").getAttribute("href")).toBe("/chat?session=x");
  });

  it("shows the chat's short ref as a copyable badge", () => {
    renderRow({ session: { ...untitledRow, ref: "C42" } });
    const badge = document.querySelector("[data-component='RefBadge']")!;
    expect(badge.getAttribute("data-ref")).toBe("C42");
    renderRow({ session: untitledRow });
    expect(document.querySelectorAll("[data-component='RefBadge']").length).toBe(1);
  });

  it("marks live sessions with a dot and 'working now'", () => {
    renderRow({ session: liveRow });
    expect(screen.getByRole("img", { name: "Working now" })).toBeTruthy();
    expect(screen.getByText("Default · working now")).toBeTruthy();
  });

  it("shows when every chat was last updated, live ones included", () => {
    const { rerender } = renderRow({ session: pinnedRow });
    const time = document.querySelector("time[data-slot='session-updated']")!;
    expect(time.textContent).toBe("Last updated 14 min ago");
    expect(time.getAttribute("dateTime")).toBe(new Date(pinnedRow.last_active! * 1000).toISOString());
    expect(time.getAttribute("title")).toMatch(/^Last updated /);
    rerender(
      <ul>
        <SessionRow session={liveRow} href="/x" profileLabel="Default" now={NOW} />
      </ul>,
    );
    expect(document.querySelector("time[data-slot='session-updated']")!.textContent).toBe("Last updated 1 min ago");
  });

  it("marks the chat to continue with a badge, unless it is already open", () => {
    const { rerender } = renderRow({ session: pinnedRow, resume: true });
    const li = document.querySelector("li")!;
    expect(li.getAttribute("data-state")).toBe("resume");
    expect(li.className).toContain("ring-[var(--color-accent)]");
    expect(screen.getByText("Continue").getAttribute("data-slot")).toBe("continue-badge");
    expect(screen.getByRole("link").getAttribute("title")).toBe("Continue your last chat");
    rerender(
      <ul>
        <SessionRow session={pinnedRow} href="/x" profileLabel="Default" now={NOW} resume active />
      </ul>,
    );
    expect(document.querySelector("li")!.getAttribute("data-state")).toBe("active");
    expect(screen.queryByText("Continue")).toBeNull();
  });

  it("archives the chat from its row and locks while busy", () => {
    const onArchive = vi.fn();
    const { rerender } = renderRow({ session: pinnedRow, onArchive });
    fireEvent.click(screen.getByRole("button", { name: "Archive “Refactor billing webhooks”" }));
    expect(onArchive).toHaveBeenCalledWith(pinnedRow);
    rerender(
      <ul>
        <SessionRow session={pinnedRow} href="/x" profileLabel="Default" now={NOW} onArchive={onArchive} busy />
      </ul>,
    );
    const btn = screen.getByRole("button", { name: "Archive “Refactor billing webhooks”" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("toggles pin and reflects pinned state", () => {
    const onTogglePin = vi.fn();
    renderRow({ session: pinnedRow, onTogglePin });
    const btn = screen.getByRole("button", { name: "Unpin “Refactor billing webhooks”" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(onTogglePin).toHaveBeenCalledWith(pinnedRow);
  });

  it("hides pin controls when pins are unavailable", () => {
    renderRow({ canPin: false, onTogglePin: vi.fn() });
    expect(screen.queryByRole("button", { name: /Pin/ })).toBeNull();
  });

  it("renames inline: Enter saves", async () => {
    const onRename = vi.fn(async () => true);
    renderRow({ session: pinnedRow, onRename });
    fireEvent.click(screen.getByRole("button", { name: "Rename “Refactor billing webhooks”" }));
    const input = screen.getByLabelText("Chat title") as HTMLInputElement;
    expect(input.value).toBe("Refactor billing webhooks");
    fireEvent.change(input, { target: { value: "Billing webhooks v2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByLabelText("Chat title")).toBeNull());
    expect(onRename).toHaveBeenCalledWith(pinnedRow, "Billing webhooks v2");
  });

  it("renames inline: Esc cancels without saving", () => {
    const onRename = vi.fn(async () => true);
    renderRow({ onRename });
    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    const input = screen.getByLabelText("Chat title");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Chat title")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps the input open when the save fails", async () => {
    const onRename = vi.fn(async () => false);
    renderRow({ onRename });
    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    const input = screen.getByLabelText("Chat title");
    fireEvent.change(input, { target: { value: "Nightly sync" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(screen.getByLabelText("Chat title")).toBeTruthy();
  });
});

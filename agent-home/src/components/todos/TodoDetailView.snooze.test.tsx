// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodoDetailView } from "@/components/todos/TodoDetailView";
import type { Todo, TodoDetail } from "@/types";

const NOTIFIED = "2026-08-11T09:00:00+00:00";

const TODO: TodoDetail = {
  id: "tsk_1",
  owner_user_id: "leo_owner",
  visibility: "private:leo_owner",
  title: "Send Ada the signed quote",
  description: "",
  stage: "open",
  status: "pending",
  priority: "high",
  origin: "triage",
  current_state: "captured",
  trigger_state: "captured",
  completion_state: "done",
  due_at: null,
  source_kind: "user",
  source_ref: null,
  source_note: null,
  notified_at: NOTIFIED,
  snoozed_until: null,
  closed_at: null,
  outcome: null,
  work_result: null,
  created_at: null,
  updated_at: null,
  history: [],
  source: null,
};

function reply(body: Partial<Todo> & { detail?: string }, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TodoDetailView snooze + Undo", () => {
  it("Undo clears the snooze through /unsnooze with the pre-snooze state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply({ ...TODO, snoozed_until: "2026-08-12T12:00:00+00:00", notified_at: null }),
      )
      .mockResolvedValueOnce(reply({ ...TODO }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TodoDetailView todo={TODO} />);

    await press(screen.getAllByRole("button", { name: "3 hours" })[0]);
    expect(screen.getByText("Snoozed until")).toBeTruthy();
    await press(screen.getByRole("button", { name: /undo/i }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/todos/tsk_1/unsnooze");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ until: null, notified_at: NOTIFIED });
    expect(screen.queryByText("Snoozed until")).toBeNull();
    // Never "snooze until now" — the old workaround.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/snooze"))).toHaveLength(1);
  });

  it("Undo puts an earlier snooze back instead of clearing it", async () => {
    const earlier = "2026-08-12T09:00:00+00:00";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ ...TODO, snoozed_until: "2026-08-19T09:00:00+00:00" }))
      .mockResolvedValueOnce(reply({ ...TODO, snoozed_until: earlier }));
    vi.stubGlobal("fetch", fetchMock);
    render(<TodoDetailView todo={{ ...TODO, snoozed_until: earlier, notified_at: null }} />);

    await press(screen.getAllByRole("button", { name: "Next week" })[0]);
    await press(screen.getByRole("button", { name: /undo/i }));

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      until: earlier,
      notified_at: null,
    });
  });

  it("the phone More sheet's snooze offers the same Undo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ ...TODO, snoozed_until: "2026-08-12T12:00:00+00:00" }))
      .mockResolvedValueOnce(reply({ ...TODO }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<TodoDetailView todo={TODO} />);

    await press(container.querySelector<HTMLElement>('[data-action="more-actions"]')!);
    const sheet = document.querySelector<HTMLElement>('[data-component="TodoMoreSheet"]')!;
    const tomorrow = Array.from(sheet.querySelectorAll<HTMLElement>("button")).find(
      (b) => b.textContent === "Tomorrow",
    )!;
    await press(tomorrow);
    await press(screen.getByRole("button", { name: /undo/i }));

    expect(fetchMock.mock.calls[1][0]).toBe("/api/todos/tsk_1/unsnooze");
  });

  it("a snooze that failed offers nothing to undo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ detail: "nope" }, 500)));
    render(<TodoDetailView todo={TODO} />);

    await press(screen.getAllByRole("button", { name: "3 hours" })[0]);

    expect(screen.getByText("nope")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });
});

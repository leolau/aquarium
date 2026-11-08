// @vitest-environment jsdom
/**
 * The board's one-tap verbs: every write goes through `useProjectAction`
 * (one lock per card), moves the card at once, settles on the server's
 * answer, and rolls back with the reason and a Retry on a refusal.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mous/cards/rev",
  useRouter: () => router,
}));

import { BoardView } from "@/components/projects/board/BoardView";
import { BOARD, CONTEXT, PROJECT, TASKS, boardOf, card } from "@/components/projects/board/fixtures";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockReset();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred() {
  let resolve: (r: Response) => void = () => {};
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function sent(call: unknown[]): { url: string; method: string; body: unknown; key: string } {
  const init = call[1] as RequestInit;
  return {
    url: String(call[0]),
    method: String(init.method),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    key: (init.headers as Record<string, string>)[IDEMPOTENCY_HEADER],
  };
}

function renderBoard(over: Partial<Parameters<typeof BoardView>[0]> = {}) {
  const view = render(
    <BoardView project={PROJECT} board={BOARD} callerUserId="leo" canLead context={CONTEXT} {...over} />,
  );
  const strip = () => view.container.querySelector('[data-component="NeedsYouStrip"]') as HTMLElement;
  const tile = (id: string) =>
    strip().querySelector(`[data-task-id="${id}"]`) as HTMLElement | null;
  const lane = (key: string) =>
    view.container.querySelector(`[data-lane="${key}"]`) as HTMLElement;
  const laneIds = (key: string) =>
    [...lane(key).querySelectorAll("[data-task-id]")].map((el) => el.getAttribute("data-task-id"));
  const laneEmpty = (key: string) =>
    lane(key).querySelector('[data-component="LaneEmpty"]')?.textContent ?? null;
  return { ...view, strip, tile, lane, laneIds, laneEmpty };
}

describe("Approve", () => {
  it("double click sends one PATCH, moves the card at once, settles on the answer", async () => {
    const reply = deferred();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();

    const approve = within(b.tile("tri_a")!).getByText("Approve");
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = sent(fetchMock.mock.calls[0] as unknown[]);
    expect(call).toMatchObject({
      url: "/api/projects/mous/cards/tri_a",
      method: "PATCH",
      body: { status: "ready" },
    });
    expect(call.key).toBeTruthy();
    // Optimistic: already Up next as ready, and the strip says it's working.
    expect(b.laneIds("up_next")).toContain("tri_a");
    expect(b.tile("tri_a")!.getAttribute("data-status")).toBe("ready");
    const pending = within(b.tile("tri_a")!).getByText("Approving…").closest("button")!;
    expect(pending.disabled).toBe(true);

    await act(async () => {
      // A parent-gated approve lands in todo — the answer wins.
      reply.resolve(json(200, { ...TASKS[0], status: "todo" }));
    });
    await waitFor(() => expect(b.tile("tri_a")).toBeNull());
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const settled = b.lane("up_next").querySelector('[data-task-id="tri_a"]')!;
    expect(settled.getAttribute("data-status")).toBe("todo");
  });

  it("a refusal rolls the card back with the reason, and Retry re-sends the same key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(409, { detail: "the card left triage already" }))
      .mockResolvedValueOnce(json(200, { ...TASKS[0], status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();

    fireEvent.click(within(b.tile("tri_a")!).getByText("Approve"));
    const alert = await within(b.tile("tri_a")!).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't approve");
    expect(alert.textContent).toContain("left triage");
    expect(b.tile("tri_a")!.getAttribute("data-status")).toBe("triage");
    expect(b.laneIds("up_next")).toContain("tri_a");
    expect(
      b.lane("up_next").querySelector('[data-task-id="tri_a"]')!.getAttribute("data-status"),
    ).toBe("triage");
    expect((within(b.tile("tri_a")!).getByText("Approve").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();

    fireEvent.click(within(b.tile("tri_a")!).getByText("Retry"));
    await waitFor(() => expect(b.tile("tri_a")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map((c) => sent(c as unknown[]));
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual({ status: "ready" });
  });

  it("cards lock independently: one card in flight leaves the others usable", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();
    fireEvent.click(within(b.tile("tri_a")!).getByText("Approve"));
    const other = within(b.tile("tri_b")!).getByText("Approve").closest("button") as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    fireEvent.click(other);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Approve all", () => {
  it("sends each triage card once, even on repeated clicks, and settles per card", async () => {
    const reply = deferred();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();

    const all = within(b.strip()).getByText("Approve all 3");
    fireEvent.click(all);
    fireEvent.click(all);
    fireEvent.click(all);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards/approve",
      method: "POST",
      body: { task_ids: ["tri_a", "tri_b", "tri_c"] },
    });
    expect(within(b.strip()).getByText("Approving 3…")).toBeTruthy();
    // Every card is locked while the batch is out.
    for (const id of ["tri_a", "tri_b", "tri_c"]) {
      const btn = within(b.tile(id)!).getByText("Approving…").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      reply.resolve(
        json(200, {
          approved: 2,
          failed: 1,
          results: [
            { task_id: "tri_a", ok: true, card: { ...TASKS[0], status: "ready" } },
            { task_id: "tri_b", ok: true, card: { ...TASKS[1], status: "ready" } },
            { task_id: "tri_c", ok: false, error: "the card left triage already" },
          ],
        }),
      );
    });
    await waitFor(() => expect(b.tile("tri_a")).toBeNull());
    expect(b.tile("tri_b")).toBeNull();
    // The refused card is back in triage with its reason.
    expect(b.tile("tri_c")!.getAttribute("data-status")).toBe("triage");
    expect(within(b.tile("tri_c")!).getByRole("alert").textContent).toContain("left triage");
  });

  it("a failed batch puts every card back and offers Retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(503, { detail: "upstream down" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();
    fireEvent.click(within(b.strip()).getByText("Approve all 3"));
    await within(b.strip()).findByText(/Couldn.t approve them/);
    for (const id of ["tri_a", "tri_b", "tri_c"]) {
      expect(b.tile(id)!.getAttribute("data-status")).toBe("triage");
    }
    expect(within(b.strip()).getByText("Retry")).toBeTruthy();
  });
});

describe("Unblock / Assign / Archive", () => {
  it("Unblock sends one POST carrying the optional note", async () => {
    const reply = deferred();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();

    fireEvent.click(within(b.tile("blk")!).getByText("Add a note"));
    fireEvent.change(within(b.tile("blk")!).getByLabelText("Why unblock Send the digest"), {
      target: { value: "The list is attached now." },
    });
    const btn = within(b.tile("blk")!).getByText("Unblock with note");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards/blk/unblock",
      method: "POST",
      body: { reason: "The list is attached now." },
    });
    expect(within(b.tile("blk")!).getByText("Unblocking…")).toBeTruthy();
    expect(b.laneIds("up_next")).toContain("blk");

    await act(async () => {
      reply.resolve(json(200, { ...TASKS[3], status: "ready" }));
    });
    await waitFor(() => expect(b.tile("blk")).toBeNull());
    expect(b.laneIds("waiting")).not.toContain("blk");
  });

  it("Unblock without a note sends an empty body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ...TASKS[3], status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();
    fireEvent.click(within(b.tile("blk")!).getByText("Unblock"));
    await waitFor(() => expect(b.tile("blk")).toBeNull());
    expect(sent(fetchMock.mock.calls[0] as unknown[]).body).toEqual({});
  });

  it("Assign PATCHes the profile, shows it at once, and rolls back on a refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { ...TASKS[0], assignee: "researcher" }))
      .mockResolvedValueOnce(json(422, { detail: "'ghost' is not one of this project's profiles" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();

    const select = within(b.tile("tri_a")!).getByLabelText("Assign Produce four Chinese MOUs");
    fireEvent.change(select, { target: { value: "researcher" } });
    expect(within(b.tile("tri_a")!).getByText("researcher · agent")).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards/tri_a",
      method: "PATCH",
      body: { assignee: "researcher" },
    });
    // Still triage → still needs a person, now with the assignee.
    expect(within(b.tile("tri_a")!).getByText("researcher · agent")).toBeTruthy();

    fireEvent.change(within(b.tile("tri_a")!).getByLabelText("Assign Produce four Chinese MOUs"), {
      target: { value: "__none__" },
    });
    expect(within(b.tile("tri_a")!).getByText("no one yet")).toBeTruthy();
    await within(b.tile("tri_a")!).findByRole("alert");
    expect(sent(fetchMock.mock.calls[1] as unknown[]).body).toEqual({ assignee: null });
    expect(within(b.tile("tri_a")!).getByText("researcher · agent")).toBeTruthy();
  });

  it("Archive takes the card off at once and brings it back on a refusal", async () => {
    const reply = deferred();
    vi.stubGlobal("fetch", vi.fn(() => reply.promise));
    const b = renderBoard();
    fireEvent.click(within(b.tile("rev")!).getByText("Archive"));
    expect(b.laneIds("waiting")).not.toContain("rev");
    expect(within(b.tile("rev")!).getAllByText("Archiving…").length).toBeGreaterThan(0);
    await act(async () => {
      reply.resolve(json(409, { detail: "the card is already archived" }));
    });
    await within(b.tile("rev")!).findByRole("alert");
    expect(b.laneIds("waiting")).toContain("rev");
  });

  it("a card waiting on an approval offers Allow / Deny instead of a bare Unblock", async () => {
    const reply = deferred();
    const fetchMock = vi.fn(() => reply.promise);
    vi.stubGlobal("fetch", fetchMock);
    const waiting = card("apv", "blocked", {
      title: "Build the deck",
      block_kind: "needs_input",
      created_by: "leo",
      pending_approvals: [
        {
          key: "mcp_canva_create_upload_url",
          label: "mcp_canva_create_upload_url",
          detail: '{"name": "logo.png"}',
          requested_at: 1,
        },
      ],
    });
    const b = renderBoard({ board: boardOf([...TASKS, waiting]) });
    const tile = b.tile("apv")!;
    expect(within(tile).getByText("Waiting on you: allow mcp_canva_create_upload_url?")).toBeTruthy();
    expect(within(tile).queryByText("Unblock")).toBeNull();
    // The plain blocked card keeps its Unblock.
    expect(within(b.tile("blk")!).getByText("Unblock")).toBeTruthy();

    const allow = within(tile).getByText("Allow on this card");
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards/apv/approvals",
      method: "POST",
      body: { key: "mcp_canva_create_upload_url", decision: "approve" },
    });
    expect(b.laneIds("up_next")).toContain("apv");
    await act(async () => {
      reply.resolve(json(200, { ...waiting, status: "ready", pending_approvals: [] }));
    });
    await waitFor(() => expect(b.tile("apv")).toBeNull());
  });

  it("a refused Deny puts the approval back with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { detail: "nothing is waiting for that approval" })));
    const waiting = card("apv", "blocked", {
      title: "Build the deck",
      pending_approvals: [{ key: "k", label: "publish the design", detail: null, requested_at: 1 }],
    });
    const b = renderBoard({ board: boardOf([...TASKS, waiting]) });
    fireEvent.click(within(b.tile("apv")!).getByText("Deny"));
    const alert = await within(b.tile("apv")!).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't deny it");
    expect(b.tile("apv")!.getAttribute("data-status")).toBe("blocked");
    expect(within(b.tile("apv")!).getByText("Waiting on you: allow publish the design?")).toBeTruthy();
  });

  it("Review opens the card page", () => {
    const b = renderBoard();
    expect(within(b.tile("rev")!).getByText("Review").getAttribute("href")).toBe(
      "/projects/mous/cards/rev",
    );
  });
});

describe("filters, lanes and the full view", () => {
  it("Mine / Agent / Needs me / run narrow the lanes and the strip", () => {
    const b = renderBoard({ callerUserId: "yan" });
    expect(b.getByText("Needs me · 5")).toBeTruthy();
    fireEvent.click(b.getByText("Mine"));
    expect(b.tile("tri_c")).not.toBeNull();
    expect(b.tile("tri_a")).toBeNull();
    expect(b.laneIds("done")).toEqual([]);
    expect(b.lane("done").textContent).toContain("No cards match this filter.");

    fireEvent.click(b.getByText("Agent"));
    expect(b.laneIds("up_next")).toEqual(["rdy", "tri_a", "tri_b"]);

    fireEvent.click(b.getByText("All"));
    fireEvent.change(b.getByLabelText("Filter by run"), { target: { value: "1" } });
    expect(b.laneIds("up_next")).toEqual(["rdy"]);
    expect(b.laneIds("done")).toEqual(["done_0"]);
  });

  it("a viewer sees what needs a person but no verbs", () => {
    const b = renderBoard({ callerUserId: "vic", canLead: false });
    expect(b.getByText("Needs me · 0")).toBeTruthy();
    expect(within(b.strip()).queryByText("Approve")).toBeNull();
    expect(within(b.strip()).queryByText(/Approve all/)).toBeNull();
    expect(within(b.strip()).getAllByText("A project member can act on this.").length).toBe(5);
  });

  it("Done shows the latest three, then +N more expands", () => {
    const b = renderBoard();
    expect(b.laneIds("done")).toEqual(["done_0", "done_1", "done_2"]);
    fireEvent.click(b.getByText("+2 more"));
    expect(b.laneIds("done")).toHaveLength(5);
  });

  it("Working tells the truth: the open run is stalled, then not once a card is ready", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard({ board: boardOf(TASKS.filter((t) => t.id !== "rdy")) });
    expect(b.laneEmpty("working")).toBe("Nothing running. Run 2 is stalled — see why.");
    expect(within(b.lane("working")).getByText("see why").getAttribute("href")).toBe("/projects/mous/runs/2");
    fireEvent.click(within(b.tile("tri_a")!).getByText("Approve"));
    expect(b.laneEmpty("working")).toBe(
      "Nothing running yet. Run 2's next card is waiting for a worker.",
    );
  });

  it("Show all 8 stages restores the stage view and its Move to…", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ...TASKS[5], status: "done" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard();
    fireEvent.click(b.getByText("Show all 8 stages"));
    expect(b.container.querySelector('[data-component="BoardPanel"]')).not.toBeNull();
    expect(b.container.querySelectorAll('[data-component="BoardColumn"]')).toHaveLength(8);
    expect(b.strip()).toBeNull();

    const select = b.getByLabelText("Move Revise MOUs to five-party structure") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "done" } });
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards/rdy",
      method: "PATCH",
      body: { status: "done" },
    });

    fireEvent.click(b.getByText("Show 4 lanes"));
    expect(b.strip()).not.toBeNull();
  });

  it("+ New card creates in triage and shows it in Needs you", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { task_id: "t_new", status: "triage" }));
    vi.stubGlobal("fetch", fetchMock);
    const b = renderBoard({ board: boardOf([card("x", "done")]) });
    fireEvent.click(b.getByText("＋ New card"));
    fireEvent.change(b.getByLabelText("New card title"), { target: { value: "Ship it" } });
    const create = b.getByText("Create");
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(b.tile("t_new")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      url: "/api/projects/mous/cards",
      method: "POST",
      body: { title: "Ship it" },
    });
    expect(b.queryByLabelText("New card title")).toBeNull();
  });
});

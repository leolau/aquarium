// @vitest-environment jsdom
/**
 * The "nothing happened" bug: a write succeeded, `router.refresh()` was
 * fired, but the buttons re-enabled and the page kept its old state until
 * the server render landed (or the user left and came back). These pin the
 * two halves of the fix — busy held across the refresh, and a local copy of
 * a server prop that follows the prop.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { CardActions } from "@/components/projects/CardActions";
import { useServerState } from "@/components/ui/useRefresh";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  router.refresh.mockReset();
});

function Row({ row }: { row: { id: string; status: string } }) {
  const [card, setCard] = useServerState(row);
  return (
    <div>
      <span data-testid="status">{card.status}</span>
      <button type="button" onClick={() => setCard({ ...card, status: "local" })}>
        patch
      </button>
    </div>
  );
}

describe("useServerState", () => {
  it("follows a new server row but keeps local patches in between", () => {
    const first = { id: "t_1", status: "blocked" };
    const { getByTestId, getByText, rerender } = render(<Row row={first} />);
    expect(getByTestId("status").textContent).toBe("blocked");

    fireEvent.click(getByText("patch"));
    expect(getByTestId("status").textContent).toBe("local");

    // Same object again (a parent re-render) — the local patch survives.
    rerender(<Row row={first} />);
    expect(getByTestId("status").textContent).toBe("local");

    // A fresh server render hands down a new object — it wins.
    rerender(<Row row={{ id: "t_1", status: "ready" }} />);
    expect(getByTestId("status").textContent).toBe("ready");
  });
});

describe("CardActions — Re-run a blocked card", () => {
  it("disables the button from the click until the refresh has rendered", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    // A refresh that takes a while to land: the transition stays pending
    // until the promise it awaits settles.
    let landRefresh: () => void = () => {};
    router.refresh.mockImplementation(
      () => new Promise<void>((resolve) => (landRefresh = resolve)),
    );

    const { getByText, getByRole } = render(
      <CardActions slug="digest" taskId="t_1" status="blocked" />,
    );
    const button = getByText("Re-run card").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe("/api/projects/digest/cards/t_1/unblock");
    expect(call[1]).toMatchObject({ method: "POST", body: JSON.stringify({}) });

    await act(async () => {
      resolveFetch(new Response("{}", { status: 200 }));
    });
    // PATCH answered, refresh in flight: still busy, still one click only.
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(getByRole("status").textContent).toContain("Re-running");

    await act(async () => {
      landRefresh();
    });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("re-enables and explains when the write fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Card is claimed by a worker." }), {
        status: 409,
      }),
    );
    const { getByText, findByText } = render(
      <CardActions slug="digest" taskId="t_1" status="blocked" />,
    );
    fireEvent.click(getByText("Re-run card"));
    await findByText(/claimed by a worker/);
    expect((getByText("Re-run card").closest("button") as HTMLButtonElement).disabled).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

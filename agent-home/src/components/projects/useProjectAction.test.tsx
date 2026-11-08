// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import { ActionButton } from "@/components/projects/ActionButton";
import {
  IDEMPOTENCY_HEADER,
  newIdempotencyKey,
  sendProjectAction,
  useProjectAction,
} from "@/components/projects/useProjectAction";

afterEach(() => {
  cleanup();
  router.refresh.mockReset();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("sendProjectAction", () => {
  it("sends the idempotency key and a JSON body", async () => {
    const fetchImpl = vi.fn(async () => json(201, { run: { run_no: 3 } }));
    const result = await sendProjectAction(
      "/api/projects/p/runs",
      "key-1",
      { method: "POST", body: { a: 1 } },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, status: 201, data: { run: { run_no: 3 } }, error: null });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[IDEMPOTENCY_HEADER]).toBe("key-1");
    expect(headers["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
  });

  it("omits the body and content-type when there is none", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await sendProjectAction("/x", "k", {}, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("turns a refusal into a sentence", async () => {
    const fetchImpl = vi.fn(async () => json(409, { detail: "run 1 is still running" }));
    const result = await sendProjectAction("/x", "k", {}, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toBeTruthy();
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const result = await sendProjectAction("/x", "k", {}, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, status: 0, data: null, error: "Could not reach the server." });
  });
});

describe("newIdempotencyKey", () => {
  it("is unique per call", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });
});

function Harness({ fetchImpl, onSuccess }: { fetchImpl: typeof fetch; onSuccess?: (d: unknown) => void }) {
  const action = useProjectAction(fetchImpl);
  return (
    <div>
      <ActionButton
        busy={action.busy}
        pendingLabel="Starting…"
        onClick={() => void action.run("/api/projects/p/runs", { onSuccess })}
      >
        Run now
      </ActionButton>
      <button type="button" onClick={() => void action.retry()}>
        retry
      </button>
      <span data-testid="phase">{action.phase}</span>
      {action.error ? <p role="alert">{action.error}</p> : null}
    </div>
  );
}

describe("useProjectAction", () => {
  it("ignores a double click while the first is in flight", async () => {
    const d = deferred<Response>();
    const fetchImpl = vi.fn(() => d.promise);
    const { getByText, getByTestId } = render(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    const button = getByText("Run now").closest("button")!;
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getByTestId("phase").textContent).toBe("pending");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Starting…");
    await act(async () => {
      d.resolve(json(201, { ok: true }));
    });
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it("hands the server answer to onSuccess before refreshing", async () => {
    const onSuccess = vi.fn();
    const fetchImpl = vi.fn(async () => json(201, { run: { run_no: 3 } }));
    const { getByText } = render(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch} onSuccess={onSuccess} />,
    );
    await act(async () => {
      fireEvent.click(getByText("Run now"));
    });
    expect(onSuccess).toHaveBeenCalledWith({ run: { run_no: 3 } });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the error, re-enables, and retries with the same key", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json(200, { replayed: true }));
    const { getByText, getByRole, getByTestId } = render(
      <Harness fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    await act(async () => {
      fireEvent.click(getByText("Run now"));
    });
    expect(getByRole("alert").textContent).toBe("Could not reach the server.");
    expect(getByTestId("phase").textContent).toBe("error");
    expect(getByText("Run now").closest("button")!.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(getByText("retry"));
    });
    const k1 = ((fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    const k2 = ((fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    expect(k1).toBe(k2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh key for a new click after success", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const { getByText } = render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await act(async () => {
      fireEvent.click(getByText("Run now"));
    });
    await act(async () => {
      fireEvent.click(getByText("Run now"));
    });
    const keys = fetchImpl.mock.calls.map(
      (c) => (((c as unknown as [string, RequestInit])[1].headers) as Record<string, string>)[IDEMPOTENCY_HEADER],
    );
    expect(keys[0]).not.toBe(keys[1]);
  });
});

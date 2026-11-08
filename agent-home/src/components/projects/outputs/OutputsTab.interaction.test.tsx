// @vitest-environment jsdom
/**
 * Every Outputs-tab write: one request per double click, a pending label
 * and disabled button while in flight, the server's new state shown on
 * success, and an error with the button re-enabled on failure.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import {
  ARTIFACT,
  DELIVERY,
  OUTPUT,
  PROJECT,
  TAB_PROPS,
  deferred,
  json,
} from "@/components/projects/outputs/fixtures";
import { OutputsPanel } from "@/components/projects/panels/OutputsPanel";
import { OutputsTab } from "@/components/projects/tabs/OutputsTab";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";

afterEach(() => {
  cleanup();
  router.refresh.mockReset();
});

const DELIVERED = OUTPUT({ status: "delivered", deliveries: [DELIVERY()] });
const PENDING = OUTPUT({ id: "out_2", seq: 2, title: "4 MOUs in docx" });

/** A fetch double whose mutation answers are held until released. */
function mutationFetch(answer: () => Promise<Response>, reread: unknown[] = []) {
  const writes: Array<[string, RequestInit]> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === "GET") return json(200, reread);
    writes.push([url, init]);
    return answer();
  });
  vi.stubGlobal("fetch", impl);
  return { writes };
}

function mount(outputs = [DELIVERED, PENDING], extra = {}) {
  return render(
    <OutputsTab
      {...TAB_PROPS(PROJECT({ outputs }), extra)}
      initialArtifacts={[ARTIFACT({ id: "f:1" }), ARTIFACT({ id: "f:2", title: "mou-partner.docx" })]}
    />,
  );
}

function card(container: HTMLElement, outputId: string): HTMLElement {
  return container.querySelector(`[data-output-id="${outputId}"]`) as HTMLElement;
}

function button(root: HTMLElement, text: RegExp): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));
  if (!found) throw new Error(`no button ${text}`);
  return found as HTMLButtonElement;
}

describe("Accept", () => {
  it("double click sends one request, shows pending, then the accepted state", async () => {
    const gate = deferred<Response>();
    const { writes } = mutationFetch(() => gate.promise);
    const { container } = mount();
    const accept = button(card(container, "out_1"), /^Accept$/);
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/projects/mou/outputs/out_1/accept");
    expect((writes[0][1].headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBeTruthy();
    await waitFor(() => expect(button(card(container, "out_1"), /Accepting…/).disabled).toBe(true));

    await act(async () => {
      gate.resolve(
        json(200, {
          output: { id: "out_1", status: "accepted", accepted_at: 1_760_000_000, accepted_by: "leo" },
          offers_closure: true,
        }),
      );
    });
    await waitFor(() =>
      expect(card(container, "out_1").querySelector('[data-testid="output-state"]')?.textContent).toBe(
        "accepted · v1",
      ),
    );
    expect(card(container, "out_1").textContent).toContain("by leo");
    expect(container.querySelector('[data-component="ClosureOffer"]')).not.toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a failure shows the error and re-enables the button", async () => {
    mutationFetch(async () => json(409, { detail: "already accepted elsewhere" }));
    const { container } = mount();
    fireEvent.click(button(card(container, "out_1"), /^Accept$/));
    await waitFor(() => expect(card(container, "out_1").querySelector('[role="alert"]')).not.toBeNull());
    expect(button(card(container, "out_1"), /^Accept$/).disabled).toBe(false);
    expect(card(container, "out_1").querySelector('[data-testid="output-state"]')?.textContent).toBe(
      "delivered · v1",
    );
  });
});

describe("Request changes", () => {
  it("opens the change flow pre-filled with the output", () => {
    mutationFetch(async () => json(200, {}));
    const onChangeRequest = vi.fn();
    const { container } = mount(undefined, { onChangeRequest });
    fireEvent.click(button(card(container, "out_1"), /Request changes/));
    expect(onChangeRequest).toHaveBeenCalledWith("Change output 2 MOUs in docx: ");
  });
});

describe("Mark superseded", () => {
  it("double click sends one PATCH and shows superseded from the response", async () => {
    const gate = deferred<Response>();
    const { writes } = mutationFetch(() => gate.promise);
    const { container } = mount();
    const btn = button(card(container, "out_1"), /Mark superseded/);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(writes).toHaveLength(1);
    expect(writes[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(writes[0][1].body))).toEqual({ status: "dropped" });
    await waitFor(() => expect(button(card(container, "out_1"), /Marking superseded…/).disabled).toBe(true));
    await act(async () => {
      gate.resolve(json(200, { ...DELIVERED, deliveries: undefined, status: "dropped" }));
    });
    await waitFor(() =>
      expect(card(container, "out_1").querySelector('[data-testid="output-state"]')?.textContent).toBe(
        "superseded",
      ),
    );
    expect(card(container, "out_1").textContent).not.toContain("Mark superseded");
  });

  it("a failure shows the error and Retry re-sends the same key", async () => {
    let calls = 0;
    const { writes } = mutationFetch(async () =>
      ++calls === 1 ? json(500, { detail: "boom" }) : json(200, { ...DELIVERED, status: "dropped" }),
    );
    const { container } = mount();
    fireEvent.click(button(card(container, "out_1"), /Mark superseded/));
    await waitFor(() => expect(card(container, "out_1").querySelector('[role="alert"]')).not.toBeNull());
    expect(button(card(container, "out_1"), /Mark superseded/).disabled).toBe(false);
    fireEvent.click(button(card(container, "out_1"), /Retry/));
    await waitFor(() =>
      expect(card(container, "out_1").querySelector('[data-testid="output-state"]')?.textContent).toBe(
        "superseded",
      ),
    );
    const key = (i: number) => (writes[i][1].headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    expect(writes).toHaveLength(2);
    expect(key(1)).toBe(key(0));
  });
});

describe("Attach to output", () => {
  it("each file locks on its own, sends one deliver, and leaves the warning", async () => {
    const gate = deferred<Response>();
    // The re-read after attaching still lists the other, unattached draft.
    const { writes } = mutationFetch(() => gate.promise, [
      ARTIFACT({ id: "f:2", title: "mou-partner.docx" }),
    ]);
    const { container } = mount();
    const rows = container.querySelectorAll('[data-component="AttachRow"]');
    expect(rows).toHaveLength(2);
    const first = button(rows[0] as HTMLElement, /^Add to output$/);
    fireEvent.click(first);
    fireEvent.click(first);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/projects/mou/outputs/out_2/deliver");
    expect(JSON.parse(String(writes[0][1].body))).toMatchObject({
      link_kind: "workspace",
      run_id: "run_a",
      task_id: "t_1",
    });
    await waitFor(() => expect(button(rows[0] as HTMLElement, /Adding…/).disabled).toBe(true));
    // The other row is not locked by this one.
    expect(button(rows[1] as HTMLElement, /^Add to output$/).disabled).toBe(false);
    await act(async () => {
      gate.resolve(json(200, { delivery_id: "d_new", output_id: "out_2", by: "leo" }));
    });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-component="AttachRow"]')).toHaveLength(1),
    );
    expect(card(container, "out_2").querySelector('[data-testid="output-state"]')?.textContent).toBe(
      "delivered · v1",
    );
  });

  it("a failure keeps the file listed with an error and the button enabled", async () => {
    mutationFetch(async () => json(404, { detail: "unknown output" }));
    const { container } = mount();
    const row = container.querySelector('[data-component="AttachRow"]') as HTMLElement;
    fireEvent.click(button(row, /^Add to output$/));
    await waitFor(() => expect(row.querySelector('[role="alert"]')).not.toBeNull());
    expect(button(row, /^Add to output$/).disabled).toBe(false);
    expect(container.querySelectorAll('[data-component="AttachRow"]')).toHaveLength(2);
  });
});

describe("Remove and Add output", () => {
  it("Remove sends one DELETE and drops the row on success", async () => {
    const { writes } = mutationFetch(async () => json(200, { deleted: "out_2" }));
    const { container } = mount();
    const btn = button(card(container, "out_2"), /^Remove$/);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(writes).toHaveLength(1);
    expect(writes[0][1].method).toBe("DELETE");
    await waitFor(() => expect(card(container, "out_2")).toBeNull());
  });

  it("Add output posts once and shows the server's row", async () => {
    const gate = deferred<Response>();
    const { writes } = mutationFetch(() => gate.promise);
    const { container, getByLabelText } = mount();
    fireEvent.change(getByLabelText("Output title"), { target: { value: "Signed scans" } });
    const add = button(container, /^Add output$/);
    fireEvent.click(add);
    fireEvent.click(add);
    expect(writes).toHaveLength(1);
    await waitFor(() => expect(button(container, /Adding…/).disabled).toBe(true));
    await act(async () => {
      gate.resolve(json(200, OUTPUT({ id: "out_3", seq: 3, title: "Signed scans" })));
    });
    await waitFor(() => expect(card(container, "out_3")).not.toBeNull());
  });
});

describe("OutputsPanel (dashboard) Accept", () => {
  it("double click sends one request and shows accepted from the response", async () => {
    const gate = deferred<Response>();
    const { writes } = mutationFetch(() => gate.promise);
    const { container } = render(<OutputsPanel slug="mou" outputs={[DELIVERED]} />);
    const accept = button(container, /^Accept$/);
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(writes).toHaveLength(1);
    await waitFor(() => expect(button(container, /Accepting…/).disabled).toBe(true));
    await act(async () => {
      gate.resolve(json(200, { output: { id: "out_1", status: "accepted" } }));
    });
    await waitFor(() => expect(container.textContent).toContain("accepted"));
    expect(container.textContent).not.toMatch(/Accept$/);
  });

  it("a failed accept shows the error and re-enables", async () => {
    mutationFetch(async () => json(500, {}));
    const { container } = render(<OutputsPanel slug="mou" outputs={[DELIVERED]} />);
    fireEvent.click(button(container, /^Accept$/));
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(button(container, /^Accept$/).disabled).toBe(false);
  });
});

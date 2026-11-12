// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WhoseDataPicker, type ViewablePeople } from "@/components/access/WhoseDataPicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(body: ViewablePeople | null, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const MIA: ViewablePeople = {
  me: "mia",
  role_reads: true,
  people: [
    { user_id: "mia", display: "Mia", role: "admin" },
    { user_id: "sam", display: "Sam", role: "member" },
    { user_id: "vee", display: "Vee", role: "viewer" },
  ],
};

describe("WhoseDataPicker", () => {
  it("asks the server whom it may offer, and starts on the signed-in person", async () => {
    const fetchMock = serve(MIA);
    const onChange = vi.fn();
    render(<WhoseDataPicker value={[]} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(["mia"]));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/access/viewable-people");
    expect(screen.getByRole("group").getAttribute("data-component")).toBe("WhoseDataPicker");
  });

  it("is hidden when you may only see your own data", async () => {
    const fetchMock = serve({ me: "sam", role_reads: false, people: [{ user_id: "sam", display: "Sam", role: "member" }] });
    const onChange = vi.fn();
    const { container } = render(<WhoseDataPicker value={[]} onChange={onChange} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector('[data-component="WhoseDataPicker"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is hidden when the server refuses", async () => {
    serve(null, 401);
    const { container } = render(<WhoseDataPicker value={[]} onChange={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-component="WhoseDataPicker"]')).toBeNull();
  });

  it("adds and removes people, and never leaves nobody picked", async () => {
    serve(MIA);
    const onChange = vi.fn();
    const { rerender } = render(<WhoseDataPicker value={["mia"]} onChange={onChange} />);
    const sam = await screen.findByLabelText("Sam");
    fireEvent.click(sam);
    expect(onChange).toHaveBeenLastCalledWith(["mia", "sam"]);
    rerender(<WhoseDataPicker value={["sam"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Sam"));
    expect(onChange).toHaveBeenLastCalledWith(["mia"]);
    expect(screen.getByLabelText("Me")).toBeTruthy();
  });
});

describe("ownerLabel", () => {
  it("names whose a row is only once the view reaches past yourself", async () => {
    const { ownerLabel } = await import("@/components/access/WhoseDataPicker");
    expect(ownerLabel(MIA, ["mia"], "mia")).toBeNull();
    expect(ownerLabel(MIA, ["mia", "sam"], "sam")).toBe("Sam");
    expect(ownerLabel(MIA, ["mia", "sam"], "mia")).toBe("Me");
    expect(ownerLabel(MIA, ["sam"], "someone-else")).toBe("someone-else");
    expect(ownerLabel(null, ["sam"], "sam")).toBeNull();
  });
});

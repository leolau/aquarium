// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WhoseDataPicker } from "@/components/access/WhoseDataPicker";
import { MAX_OWNERS, type ViewablePeople } from "@/lib/whose-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  it("renders nothing when there is nobody but you to pick", () => {
    const { container } = render(<WhoseDataPicker people={null} value={[]} onChange={vi.fn()} />);
    expect(container.querySelector('[data-component="WhoseDataPicker"]')).toBeNull();
  });

  it("offers the server's people, with you as Me, and fetches nothing itself", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<WhoseDataPicker people={MIA} value={["mia"]} onChange={vi.fn()} />);
    expect(screen.getByRole("group").getAttribute("data-component")).toBe("WhoseDataPicker");
    expect((screen.getByLabelText("Me") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Sam") as HTMLInputElement).checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds and removes people, and never leaves nobody picked", () => {
    const onChange = vi.fn();
    const { rerender } = render(<WhoseDataPicker people={MIA} value={["mia"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Sam"));
    expect(onChange).toHaveBeenLastCalledWith(["mia", "sam"]);
    rerender(<WhoseDataPicker people={MIA} value={["sam"]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Sam"));
    expect(onChange).toHaveBeenLastCalledWith(["mia"]);
  });

  it(`stops at ${MAX_OWNERS} people, the most one filter may name`, () => {
    const many: ViewablePeople = {
      me: "p0",
      role_reads: false,
      people: Array.from({ length: MAX_OWNERS + 1 }, (_, i) => ({
        user_id: `p${i}`, display: `P${i}`, role: "member",
      })),
    };
    const picked = many.people.slice(0, MAX_OWNERS).map((p) => p.user_id);
    render(<WhoseDataPicker people={many} value={picked} onChange={vi.fn()} />);
    expect((screen.getByLabelText(`P${MAX_OWNERS}`) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("P1") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(`Up to ${MAX_OWNERS} people at once.`)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AquariumIdleSetting, CreaturePicker, parseIdleInput } from "@/components/settings/AquariumSettings";
import { CREATURES } from "@/lib/aquarium/creatures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Call = { url: string; method: string; body: unknown };

function mockFetch(handler: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("parseIdleInput", () => {
  it("accepts whole seconds from 5 to 3600 only", () => {
    expect(parseIdleInput("30")).toBe(30);
    expect(parseIdleInput(" 5 ")).toBe(5);
    expect(parseIdleInput("3600")).toBe(3600);
    for (const bad of ["", "0", "4", "3601", "12.5", "-10", "abc", "1e2"]) {
      expect(parseIdleInput(bad)).toBeNull();
    }
  });
});

describe("AquariumIdleSetting", () => {
  it("renders nothing and fetches nothing for members", () => {
    const calls = mockFetch(() => ({ idle_seconds: 30 }));
    const { container } = render(<AquariumIdleSetting canEdit={false} />);
    expect(container.innerHTML).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("loads the current value and saves a new one", async () => {
    const calls = mockFetch((c) => (c.method === "PUT" ? { idle_seconds: (c.body as { idle_seconds: number }).idle_seconds } : { idle_seconds: 45 }));
    render(<AquariumIdleSetting canEdit />);
    const input = screen.getByRole("spinbutton");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("45"));
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(calls.at(-1)).toEqual({ url: "/api/aquarium/settings", method: "PUT", body: { idle_seconds: 120 } });
  });

  it("blocks out-of-range values before saving", async () => {
    const calls = mockFetch(() => ({ idle_seconds: 30 }));
    render(<AquariumIdleSetting canEdit />);
    const input = screen.getByRole("spinbutton");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("30"));
    for (const bad of ["0", "4", "3601"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByRole("alert").textContent).toContain("5 to 3600");
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.submit(input.closest("form")!);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("shows the server's refusal", async () => {
    mockFetch((c) =>
      c.method === "PUT" ? new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 }) : { idle_seconds: 30 },
    );
    render(<AquariumIdleSetting canEdit />);
    await waitFor(() => expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("30"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("forbidden");
  });
});

describe("CreaturePicker", () => {
  it("shows all 20 creatures with the current one highlighted", async () => {
    mockFetch(() => ({ creature: "octopus", chosen: false }));
    render(<CreaturePicker />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(CREATURES.length);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Octopus" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("saves the picked creature and moves the highlight", async () => {
    const calls = mockFetch((c) =>
      c.method === "PUT" ? { creature: (c.body as { creature: string }).creature, chosen: true } : { creature: "octopus", chosen: false },
    );
    render(<CreaturePicker />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Octopus" }).getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Narwhal" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Narwhal" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByRole("button", { name: "Octopus" }).getAttribute("aria-pressed")).toBe("false");
    expect(calls.at(-1)).toEqual({ url: "/api/me/creature", method: "PUT", body: { creature: "narwhal" } });
  });

  it("keeps the old creature when saving fails", async () => {
    mockFetch((c) =>
      c.method === "PUT" ? new Response(JSON.stringify({ detail: "unknown creature" }), { status: 400 }) : { creature: "crab", chosen: true },
    );
    render(<CreaturePicker />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Crab" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Shark" }));
    expect((await screen.findByRole("alert")).textContent).toContain("unknown creature");
    expect(screen.getByRole("button", { name: "Crab" }).getAttribute("aria-pressed")).toBe("true");
  });
});

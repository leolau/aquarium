// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AquariumIdleSetting,
  CreaturePicker,
  normaliseNameInput,
  parseIdleInput,
} from "@/components/settings/AquariumSettings";
import { AQUARIUM_NAME_MAX, CREATURES, creatureSprite } from "@/lib/aquarium/creatures";

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

const idleForm = () => within(document.querySelector<HTMLFormElement>('[data-form="aquarium-idle"]')!);
const nameForm = () => within(document.querySelector<HTMLFormElement>('[data-form="aquarium-name"]')!);

describe("normaliseNameInput", () => {
  it("trims, allows empty (the default) and caps the length in characters", () => {
    expect(normaliseNameInput("  Reef  ")).toBe("Reef");
    expect(normaliseNameInput("   ")).toBe("");
    expect(normaliseNameInput("魚".repeat(AQUARIUM_NAME_MAX))).toBe("魚".repeat(AQUARIUM_NAME_MAX));
    expect(normaliseNameInput("x".repeat(AQUARIUM_NAME_MAX + 1))).toBeNull();
  });
});

describe("AquariumIdleSetting", () => {
  it("renders nothing and fetches nothing for members", () => {
    const calls = mockFetch(() => ({ idle_seconds: 30 }));
    const { container } = render(<AquariumIdleSetting canEdit={false} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("loads the current value and saves a new one", async () => {
    const calls = mockFetch((c) => (c.method === "PUT" ? { idle_seconds: (c.body as { idle_seconds: number }).idle_seconds } : { idle_seconds: 45 }));
    render(<AquariumIdleSetting canEdit />);
    const input = screen.getByRole("spinbutton");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("45"));
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(idleForm().getByRole("button", { name: "Save" }));
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
      expect((idleForm().getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.submit(input.closest("form")!);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("loads the aquarium name and saves a new one with only {name}", async () => {
    const calls = mockFetch((c) =>
      c.method === "PUT"
        ? { idle_seconds: 30, name: (c.body as { name: string }).name || "Aquarium" }
        : { idle_seconds: 30, name: "Ocean Lab" },
    );
    render(<AquariumIdleSetting canEdit />);
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Ocean Lab"));
    expect(input.placeholder).toBe("Aquarium");
    expect(input.maxLength).toBe(AQUARIUM_NAME_MAX);
    fireEvent.change(input, { target: { value: "  Reef Club  " } });
    fireEvent.click(nameForm().getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(calls.at(-1)).toEqual({ url: "/api/aquarium/settings", method: "PUT", body: { name: "Reef Club" } });
    expect(input.value).toBe("Reef Club");
  });

  it("shows the default as a placeholder and an empty name resets it", async () => {
    const calls = mockFetch((c) => (c.method === "PUT" ? { idle_seconds: 30, name: "Aquarium" } : { idle_seconds: 30, name: "Aquarium" }));
    render(<AquariumIdleSetting canEdit />);
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    await waitFor(() => expect(input.getAttribute("aria-busy")).toBe("false"));
    expect(input.value).toBe("");
    fireEvent.click(nameForm().getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(calls.at(-1)?.body).toEqual({ name: "" });
    expect(input.value).toBe("");
  });

  it("shows the server's refusal", async () => {
    mockFetch((c) =>
      c.method === "PUT" ? new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 }) : { idle_seconds: 30 },
    );
    render(<AquariumIdleSetting canEdit />);
    await waitFor(() => expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("30"));
    fireEvent.click(idleForm().getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("forbidden");
  });
});

describe("CreaturePicker", () => {
  it("shows all 40 creatures as sprites with the current one highlighted", async () => {
    mockFetch(() => ({ creature: "octopus", chosen: false }));
    render(<CreaturePicker />);
    const buttons = screen.getAllByRole("button");
    expect(CREATURES).toHaveLength(40);
    expect(buttons).toHaveLength(CREATURES.length);
    for (const c of CREATURES) {
      const button = screen.getByRole("button", { name: c.label });
      expect(button.querySelector("img")?.getAttribute("src")).toBe(creatureSprite(c.id));
    }
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

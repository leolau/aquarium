// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SystemHubAdvanced } from "./SystemHubAdvanced";
import type { HubGroup } from "./SystemHub";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const groups: HubGroup[] = [
  {
    id: "knowledge",
    label: "Knowledge",
    cards: [
      { id: "memory", href: "/memory", name: "Memory", desc: "What it remembers", meta: "3 memories", icon: null },
      { id: "graph", href: "/graph", name: "Graph", desc: "Goals and tasks", meta: "1 goal", icon: null, advanced: true },
    ],
  },
];

const hub = () =>
  render(
    <SystemHubAdvanced
      groups={groups}
      advancedHelp="Also shows the engineer pages."
      adminNote={null}
      unknown="—"
      lockedLabel="Locked"
      lockedBody=""
      settingsLead=""
      settingsLink="Settings"
    />,
  );

const cards = (app: string) => document.querySelectorAll(`[data-component="HubCard"][data-app="${app}"]`).length;

describe("SystemHubAdvanced", () => {
  it("hides engineer cards until Advanced is switched on, and remembers the choice", () => {
    hub();
    const sw = screen.getByRole("switch", { name: "Advanced" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(cards("memory")).toBeGreaterThan(0);
    expect(cards("graph")).toBe(0);

    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(cards("graph")).toBeGreaterThan(0);

    cleanup();
    hub();
    expect(cards("graph")).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import {
  NOW,
  board,
  output,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import { JourneyBar } from "@/components/projects/dashboard/JourneyBar";
import {
  JOURNEY_HINT_DISMISSED,
  JOURNEY_HINT_PENDING,
  markJourneyHintPending,
} from "@/components/projects/dashboard/journeyHint";
import { nextAction } from "@/components/projects/dashboard/nextAction";
import type { ReadinessItem } from "@/components/projects/readiness";
import { HIGHLIGHT_MS, revealTarget } from "@/components/projects/revealTarget";
import type { ProjectDetail } from "@/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  router.refresh.mockClear();
  window.localStorage.clear();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ITEM = (key: ReadinessItem["key"], ok: boolean, extra: Partial<ReadinessItem> = {}): ReadinessItem => ({
  key,
  label: key,
  ok,
  hint: `fix ${key}`,
  anchor: `?tab=${key}`,
  ...extra,
});

function Bar({
  p,
  readiness = [],
  canLead = true,
  canAct = true,
  onNavigate = vi.fn(),
  onReveal = vi.fn(),
}: {
  p: ProjectDetail;
  readiness?: ReadinessItem[];
  canLead?: boolean;
  canAct?: boolean;
  onNavigate?: (tab: string) => void;
  onReveal?: (item: ReadinessItem) => void;
}) {
  return (
    <JourneyBar
      project={p}
      action={nextAction(p, board(), readiness, playbook(), NOW, canLead)}
      readiness={readiness}
      canLead={canLead}
      canAct={canAct}
      onNavigate={onNavigate}
      onReveal={onReveal}
      onChangeRequest={vi.fn()}
    />
  );
}

const current = () => document.querySelector('[aria-current="step"] > span')?.textContent;

describe("JourneyBar", () => {
  it("highlights the current step and offers exactly one primary button", () => {
    render(<Bar p={project()} />);
    expect(current()).toBe("Ready");
    expect(screen.getAllByText(/^✓ /).map((n) => n.textContent)).toEqual(["✓ Set up"]);
    const primary = document.getElementById("journey-primary")!;
    expect(primary.querySelectorAll("button, a")).toHaveLength(1);
    expect(primary.textContent).toBe("Start iteration 1");
  });

  it("Activate: double click sends one PATCH, confirms, and the bar advances keeping the line", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { status: "active" }));
    vi.stubGlobal("fetch", fetchMock);
    const readiness = [ITEM("outputs", true), ITEM("status", false)];
    const planning = project({ status: "planning" });
    const r = render(<Bar p={planning} readiness={readiness} />);
    expect(current()).toBe("Set up");
    const button = screen.getByRole("button", { name: "Activate" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("status", {}, { timeout: 5000 })).toHaveProperty("textContent", "Project is active.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect([url, init.method, JSON.parse(String(init.body))]).toEqual(["/api/projects/mou-set", "PATCH", { status: "active" }]);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());

    // The refreshed page: active and runnable. The step moves on, the line stays.
    r.rerender(<Bar p={project()} readiness={[ITEM("outputs", true), ITEM("status", true)]} />);
    expect(current()).toBe("Ready");
    expect(screen.getByRole("button", { name: "Start iteration 1" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Project is active.");
  });

  it("Mark done shows in the bar when it is the next step", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { status: "done" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Bar p={project({ runs: [run()], outputs: [output({ status: "accepted" })] })} />);
    expect(current()).toBe("Review");
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(await screen.findByRole("status", {}, { timeout: 5000 })).toHaveProperty("textContent", "Project marked done.");
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify({ status: "done" }));
  });

  it("guided readiness: the line and the button both reveal the field that fixes the gap", () => {
    const onReveal = vi.fn();
    const onNavigate = vi.fn();
    const readiness = [
      ITEM("outputs", false, { tab: "outputs", target: "add-output" }),
      ITEM("profile", true),
      ITEM("plan", true),
      ITEM("status", false),
    ];
    render(<Bar p={project({ outputs: [], status: "planning" })} readiness={readiness} onReveal={onReveal} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "2 of 4 ready — next: declare an output →" }));
    expect(onReveal).toHaveBeenLastCalledWith(readiness[0]);
    fireEvent.click(screen.getByRole("button", { name: "Add an output" }));
    expect(onReveal).toHaveBeenCalledTimes(2);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("shows why the button is disabled instead of failing with a 403", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Bar p={project()} canLead={false} canAct={false} />);
    const button = screen.getByRole("button", { name: "Start iteration 1" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Viewers can't do this step/)).toBeTruthy();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("first-run hint: shown once after the wizard, gone for good when dismissed", () => {
    markJourneyHintPending("mou-set");
    const r = render(<Bar p={project()} />);
    expect(screen.getByRole("note").textContent).toContain("one button to press next");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(window.localStorage.getItem(JOURNEY_HINT_DISMISSED)).toBe("1");
    expect(window.localStorage.getItem(JOURNEY_HINT_PENDING)).toBeNull();
    markJourneyHintPending("other");
    expect(window.localStorage.getItem(JOURNEY_HINT_PENDING)).toBeNull();
    r.unmount();
    render(<Bar p={project()} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows no hint for a project the wizard did not just create", () => {
    markJourneyHintPending("another-project");
    render(<Bar p={project()} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("revealTarget", () => {
  it("waits for the tab to render the field, focuses it and rings it for a moment", async () => {
    vi.useFakeTimers();
    revealTarget("add-output");
    const box = document.createElement("div");
    box.id = "add-output";
    const input = document.createElement("input");
    box.appendChild(input);
    document.body.appendChild(box);
    await act(async () => vi.advanceTimersByTime(60));
    expect(box.getAttribute("data-journey-highlight")).toBe("true");
    expect(document.activeElement).toBe(input);
    await act(async () => vi.advanceTimersByTime(HIGHLIGHT_MS));
    expect(box.hasAttribute("data-journey-highlight")).toBe(false);
    box.remove();
  });
});

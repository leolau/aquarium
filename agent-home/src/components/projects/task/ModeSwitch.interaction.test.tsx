// @vitest-environment jsdom
/**
 * The Task mode | Project mode switch: it saves the choice for this
 * person's device class, flips a project page in place, and keeps
 * repeating / standing projects in Project mode.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./TaskView", () => ({
  TaskView: ({ onOpenProject }: { onOpenProject: () => void }) => (
    <div data-testid="task-view">
      <button type="button" onClick={onOpenProject}>
        Open in Project mode →
      </button>
    </div>
  ),
}));

import type { ProjectDetail } from "@/types";

import { ModeSwitch } from "./ModeSwitch";
import { ProjectViewSwitch } from "./ProjectViewSwitch";

function fetchSpy() {
  const fn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function page(cadence: ProjectDetail["cadence"], initialMode: "task" | "project" = "task") {
  const project = { slug: "p", cadence } as ProjectDetail;
  return render(
    <ProjectViewSwitch
      initialMode={initialMode}
      device="phone"
      task={{ project, board: null, playbook: null, directives: null, callerUserId: "u", isInstanceAdmin: false }}
    >
      <div data-testid="project-view" />
    </ProjectViewSwitch>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModeSwitch", () => {
  it("marks the current mode and reports the other", () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="project" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Project mode" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Project mode" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Task mode" }));
    expect(onChange).toHaveBeenCalledWith("task");
  });
});

describe("ProjectViewSwitch", () => {
  it("flips the same project in place and saves the choice for this device", () => {
    const fetchFn = fetchSpy();
    page("one_off");
    expect(screen.getByTestId("task-view")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Project mode" }));
    expect(screen.getByTestId("project-view")).toBeTruthy();
    expect(screen.queryByTestId("task-view")).toBeNull();
    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/project-view-mode");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ device: "phone", mode: "project" });
    fireEvent.click(screen.getByRole("radio", { name: "Task mode" }));
    expect(screen.getByTestId("task-view")).toBeTruthy();
  });

  it("opens in Project mode from the task's details link", () => {
    fetchSpy();
    page("one_off");
    fireEvent.click(screen.getByRole("button", { name: "Open in Project mode →" }));
    expect(screen.getByTestId("project-view")).toBeTruthy();
  });

  it("keeps a repeating or standing project in Project mode", () => {
    for (const cadence of ["repeatable", "standing"] as const) {
      page(cadence, "task");
      expect(screen.getByTestId("project-view")).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Task mode" })).toHaveProperty("disabled", true);
      cleanup();
    }
  });
});

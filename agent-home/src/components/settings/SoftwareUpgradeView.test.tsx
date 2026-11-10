// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SoftwareUpgradeView, tookLabel } from "@/components/settings/SoftwareUpgradeView";
import type { SoftwareUpgradeJob, SoftwareUpgradeStatus } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rel = (tag: string, published_at: string) => ({
  tag,
  name: tag,
  published_at,
  prerelease: false,
  url: `https://github.com/leolau/aquarium/releases/tag/${tag}`,
  highlights: [{ title: "Fixes", items: [`fix in ${tag}`] }],
});

const STATUS: SoftwareUpgradeStatus = {
  available: true,
  installed: {
    version: "v1.1.0",
    label: "v1.1.0",
    commit: null,
    kind: "release",
    channel: "stable",
    installed_at: "2026-11-01T09:00:00Z",
    by: "leo",
  },
  job: null,
  history: [],
  checked_at: "2026-11-05T08:00:00Z",
  rollback_to: null,
  releases: {
    newer: [rel("v1.3.0", "2026-11-04T00:00:00Z"), rel("v1.2.0", "2026-11-02T00:00:00Z")],
    older: [rel("v1.0.0", "2026-10-01T00:00:00Z")],
    latest: "v1.3.0",
  },
  can_upgrade: true,
};

const step = (key: string, state: string) => ({ key, state, started: null, finished: null });
const JOB: SoftwareUpgradeJob = {
  id: "j1",
  kind: "upgrade",
  from: "v1.1.0",
  to: "v1.3.0",
  by: "leo",
  started: "2026-11-05T09:00:00Z",
  finished: null,
  running: true,
  result: null,
  error: null,
  steps: [step("backup", "done"), step("download", "running"), step("checks", "pending")] as SoftwareUpgradeJob["steps"],
  log: ["== backup =="],
};

describe("SoftwareUpgradeView", () => {
  it("selects the latest release and labels the button with it", () => {
    render(<SoftwareUpgradeView initial={STATUS} />);
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Upgrade to v1.3.0");
    expect(screen.getByTestId("upgrade-banner").textContent).toContain("2 newer releases");
    expect(screen.getByText("fix in v1.3.0")).toBeTruthy();
  });

  it("lets the owner pick another release, and older ones become a roll back", () => {
    render(<SoftwareUpgradeView initial={STATUS} />);
    fireEvent.click(screen.getByText("v1.2.0"));
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Upgrade to v1.2.0");
    expect(screen.queryByTestId("upgrade-older")).toBeNull();
    fireEvent.click(screen.getByTestId("upgrade-show-older"));
    fireEvent.click(screen.getByText("v1.0.0"));
    expect(screen.getByTestId("upgrade-button").textContent).toBe("Roll back to v1.0.0");
  });

  it("asks for the password and sends only the chosen version", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ started: true, status: { ...STATUS, job: JOB } }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SoftwareUpgradeView initial={STATUS} />);
    fireEvent.click(screen.getByTestId("upgrade-button"));
    expect(screen.getByText("Upgrade to v1.3.0?")).toBeTruthy();
    expect((screen.getByTestId("upgrade-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("upgrade-confirm"));
    await waitFor(() => expect(screen.getByText("Upgrading v1.1.0 → v1.3.0")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/software-upgrade/start");
    expect(JSON.parse(String(init.body))).toEqual({ version: "v1.3.0", password: "pw" });
    vi.unstubAllGlobals();
  });

  it("is read only for admins", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, can_upgrade: false }} />);
    expect(screen.getByTestId("upgrade-read-only")).toBeTruthy();
    expect(screen.queryByTestId("upgrade-button")).toBeNull();
  });

  it("shows the running job's steps", () => {
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: JOB }} />);
    expect(document.querySelector('[data-step="download"]')?.getAttribute("data-state")).toBe("running");
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
  });

  it("offers rollback after a finished upgrade it watched", () => {
    const done = { ...JOB, running: false, result: "ok", finished: "2026-11-05T09:04:37Z" };
    render(<SoftwareUpgradeView initial={{ ...STATUS, job: done, rollback_to: "v1.1.0" }} />);
    // Not watched in this tab: the release list shows, not the finished page.
    expect(screen.getByTestId("upgrade-button")).toBeTruthy();
    expect(tookLabel(277)).toBe("4 m 37 s");
  });

  it("on a branch checkout, lists the branch commits that aren't installed", () => {
    const checkout: SoftwareUpgradeStatus = {
      ...STATUS,
      installed: { ...STATUS.installed!, version: null, label: "develop@7b09787fc", commit: "7b09787fc", kind: "checkout" },
      releases: { newer: [], older: [], latest: null },
      checkout: {
        branch: "develop",
        commit: "7b09787fc",
        behind: 2,
        tip: "5188a9b00",
        commits: [
          { sha: "5188a9b00", title: "test(smoke): page markers", date: null },
          { sha: "549c6eb00", title: "feat(agent-home): steer", date: null },
        ],
        error: null,
      },
    };
    render(<SoftwareUpgradeView initial={checkout} />);
    expect(screen.getByTestId("upgrade-banner").textContent).toBe("No newer tagged release.");
    const card = screen.getByTestId("upgrade-checkout").textContent ?? "";
    expect(card).toContain("2 commits on develop aren't installed yet.");
    expect(card).toContain("5188a9b");
    expect(card).toContain("feat(agent-home): steer");
  });

  it("on an up-to-date checkout says so, and a release install shows no branch card", () => {
    const base = { ...STATUS.installed!, version: null, label: "develop@x", commit: "abc1234", kind: "checkout" as const };
    render(
      <SoftwareUpgradeView
        initial={{ ...STATUS, installed: base, checkout: { branch: "develop", commit: "abc1234", behind: 0, tip: null, commits: [], error: null } }}
      />,
    );
    expect(screen.getByTestId("upgrade-checkout").textContent).toBe("Up to date with develop.");
    cleanup();
    render(<SoftwareUpgradeView initial={STATUS} />);
    expect(screen.queryByTestId("upgrade-checkout")).toBeNull();
  });
});

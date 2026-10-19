// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecurityBasicsItem } from "@/components/get-ready/SecurityBasicsItem";
import type { SecurityBasicsResult } from "@/lib/api/security-basics";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOT_STARTED: SecurityBasicsResult = {
  checked_at: null,
  status: "not_started",
  passed: 0,
  total: 0,
  helper: "",
  checks: [],
};

const ATTENTION: SecurityBasicsResult = {
  checked_at: "2026-10-19T08:42:00+00:00",
  status: "attention",
  passed: 4,
  total: 6,
  helper: "ok",
  checks: [
    {
      id: "tls",
      status: "ok",
      facts: { certificates: [{ domain: "aquarium.example.com", ok: true, days_left: 89, valid_until: "2027-01-16" }] },
    },
    {
      id: "ssh",
      status: "attention",
      facts: { installed: true, password_login: true, empty_passwords: false, root_password_login: false, authorized_keys: 0 },
    },
    { id: "updates", status: "ok", facts: { installed: true, enabled: true, timer_enabled: true } },
    {
      id: "ports",
      status: "attention",
      facts: { extra: [{ port: 8000, process: "docker-proxy", bypasses_firewall: true }], firewall_on: true },
    },
    {
      id: "doctor",
      status: "ok",
      facts: { total: 14, passed: 14, failed: 0, warned: 0, problems: [] },
    },
    { id: "tools_user", status: "ok", facts: { run_as: "hermes-tools", helper_installed: true } },
    { id: "two_factor", status: "unavailable", facts: { reason: "not_built" } },
  ],
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SecurityBasicsItem", () => {
  it("starts as not tested, then Test shows a busy state, blocks repeat clicks and shows the result", async () => {
    let finish: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    render(<SecurityBasicsItem initial={NOT_STARTED} lang="en" />);
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.getByText("Not tested yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const busy = await screen.findByRole("button", { name: /Testing/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/security-basics/test", { method: "POST" });

    await act(async () => finish(respond(200, ATTENTION)));
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(
      screen.getByText("4 of 6 checks pass. The server still accepts SSH passwords."),
    ).toBeTruthy();
    expect(screen.getByText(/! The server still accepts SSH passwords\. See the fix below\./)).toBeTruthy();
  });

  it("Set up opens the read-only list; commands only appear under Show me how", async () => {
    render(<SecurityBasicsItem initial={ATTENTION} lang="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.getByText(/certificate valid until 16 Jan 2027/)).toBeTruthy();
    expect(screen.getByText("Other ports are open to the internet: 8000 (skips the firewall)")).toBeTruthy();
    expect(screen.getByText(/No SSH key is set up yet/)).toBeTruthy();
    expect(screen.getByText("Health check: 14 checks, no problems")).toBeTruthy();
    expect(screen.getByText(/not available in this version yet/)).toBeTruthy();
    expect(screen.queryByText(/PasswordAuthentication no/)).toBeNull();
    const sshRow = document.querySelector('[data-check="ssh"]') as HTMLElement;
    fireEvent.click(sshRow.querySelector("button") as HTMLButtonElement);
    expect(screen.getByText(/PasswordAuthentication no/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("explains a missing check helper and how to install it", () => {
    const missing: SecurityBasicsResult = {
      ...ATTENTION,
      helper: "missing",
      checks: [{ id: "ssh", status: "unknown", facts: { reason: "helper_missing" } }],
    };
    render(<SecurityBasicsItem initial={missing} lang="en" defaultOpen />);
    expect(screen.getByText(/read-only check helper, which isn't installed yet/)).toBeTruthy();
    expect(screen.getByText("SSH sign-in: can't check yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Show me how/ })[0]);
    expect(screen.getByText(/install -m 0755 -o root -g root deploy\/hermes-security-check/)).toBeTruthy();
  });

  it("says so when a check is already running (409)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(409, { detail: "busy" }));
    render(<SecurityBasicsItem initial={NOT_STARTED} lang="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/already running/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads the last result itself when none is passed in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(200, ATTENTION));
    render(<SecurityBasicsItem lang="en" />);
    await waitFor(() => expect(screen.getByText("Needs attention")).toBeTruthy());
  });

  it("renders in Traditional Chinese", () => {
    render(<SecurityBasicsItem initial={ATTENTION} lang="zh-Hant" />);
    expect(screen.getByText("基本安全")).toBeTruthy();
    expect(screen.getByText("需要處理")).toBeTruthy();
    expect(screen.getByText("6 項檢查中 4 項通過。伺服器仍然接受 SSH 密碼登入。")).toBeTruthy();
  });
});

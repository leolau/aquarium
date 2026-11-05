// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installDecision, SkillsHubView } from "@/components/skills/SkillsHubView";
import type { SkillHubScan } from "@/types";

const scanOf = (verdict: string, policy: SkillHubScan["policy"]): SkillHubScan => ({
  name: "x",
  identifier: "x",
  source: "github",
  trust_level: "community",
  verdict,
  summary: "",
  policy,
  policy_reason: "",
  findings: [],
  severity_counts: {},
});

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const RESULTS = ["safe", "caution", "dangerous"].map((v) => ({
  name: `linear-${v}`,
  description: v,
  source: "github",
  identifier: `id-${v}`,
  trust_level: v === "safe" ? "trusted" : "community",
  repo: null,
  tags: [],
}));

describe("installDecision", () => {
  it("blocks dangerous, asks on caution, allows safe", () => {
    expect(installDecision(scanOf("dangerous", "block"))).toBe("block");
    expect(installDecision(scanOf("caution", "ask"))).toBe("ask");
    expect(installDecision(scanOf("safe", "allow"))).toBe("allow");
    expect(installDecision(scanOf("safe", "block"))).toBe("block");
    expect(installDecision(undefined)).toBe("unknown");
  });
});

describe("SkillsHubView", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/skills/hub/sources")) {
        return reply({ sources: [{ id: "github", label: "GitHub" }], featured: RESULTS, installed: {}, index_available: true });
      }
      if (url.startsWith("/api/skills/hub/scan")) {
        const v = url.split("id-")[1];
        return reply(scanOf(v, v === "safe" ? "allow" : v === "caution" ? "ask" : "block"));
      }
      if (url === "/api/skills/hub/install" && init?.method === "POST") return reply({ ok: true });
      return reply({}, 404);
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows trust and scan verdicts; dangerous is blocked, caution asks first", async () => {
    render(<SkillsHubView profile="coder" onInstalled={async () => {}} />);
    await screen.findByText("scan: Dangerous");
    expect(screen.getByText("scan: Safe")).toBeTruthy();
    expect(screen.getByText("trusted")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Install blocked" }) as HTMLButtonElement).disabled).toBe(true);

    const caution = document.querySelector('[data-identifier="id-caution"]')!;
    fireEvent.click(caution.querySelector("button:last-child")!);
    expect(await screen.findByText(/flagged this skill as/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/skills/hub/install")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Install anyway" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/skills/hub/install",
        expect.objectContaining({ body: JSON.stringify({ identifier: "id-caution", profile: "coder" }) }),
      ),
    );
  });
});

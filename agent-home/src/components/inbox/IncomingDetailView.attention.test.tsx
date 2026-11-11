// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/projects/AddToProjectSheet", () => ({ AddToProjectSheet: () => null }));

import { IncomingDetailView } from "./IncomingDetailView";
import { flagged } from "@/components/landing/incomings/__tests__/fixtures";
import type { IncomingDetail } from "@/types";

const detail = { ...flagged[2], attachments: [] } as IncomingDetail;
let bodies: unknown[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({ ...detail, attention_cleared_at: body.action === "clear" ? "2026-11-11T06:00:00Z" : null }),
        { status: 200 },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IncomingDetailView Done / Reopen", () => {
  it("marks a flagged arrival done, then reopens it", async () => {
    render(<IncomingDetailView item={detail} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Done" }));
    expect(await screen.findByText("Marked done. It's out of Incomings.")).toBeTruthy();
    expect(bodies).toEqual([{ action: "clear", outcome: "done" }]);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByText("Reopened. It's back in Incomings.")).toBeTruthy();
    expect(bodies[1]).toEqual({ action: "reopen" });
    await waitFor(() => expect(screen.getByRole("button", { name: "✓ Done" })).toBeTruthy());
  });

  it("offers neither to a viewer who doesn't own it, nor for an unflagged arrival", () => {
    render(<IncomingDetailView item={detail} canChangeAttention={false} />);
    expect(screen.queryByRole("button", { name: /Done|Reopen/ })).toBeNull();
    cleanup();
    render(<IncomingDetailView item={{ ...detail, attention_at: null }} />);
    expect(screen.queryByRole("button", { name: /Done|Reopen/ })).toBeNull();
  });

  it("explains a 403 as owner-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "api_error" }), { status: 403 })));
    render(<IncomingDetailView item={detail} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Done" }));
    expect(
      await screen.findByText("Only the person this arrived for can mark it done or reopen it."),
    ).toBeTruthy();
  });
});

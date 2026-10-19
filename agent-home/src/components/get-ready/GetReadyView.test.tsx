// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GetReadyView, summarize } from "@/components/get-ready/GetReadyView";
import { PeopleAndRoles, cellText } from "@/components/get-ready/PeopleAndRoles";
import { translate } from "@/components/get-ready/i18n";
import en from "@/i18n/messages/en/getReady.json";
import zhHant from "@/i18n/messages/zh-Hant/getReady.json";
import type { GetReadyItem, GetReadyResponse } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(over: Partial<GetReadyItem>): GetReadyItem {
  return {
    id: "vpn",
    n: 9,
    group: "connections",
    required: false,
    per_person: true,
    status: "not_started",
    detail: "vpn.none",
    params: {},
    coming: false,
    steps: [],
    last_test: null,
    ...over,
  };
}

function response(items: GetReadyItem[]): GetReadyResponse {
  return { role: "member", can_manage: false, items, summary: summarize(items) };
}

const EXTRAS = { profile: "default", people: null, peopleError: null, tools: null, currentMain: null };

describe("getReady strings", () => {
  it("has the same keys in English and Traditional Chinese", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });

  it("has wording for every status key the server can send", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../hermes_cli/get_ready.py"), "utf8");
    const keys = new Set(
      [...source.matchAll(/"((?:owner|model|people|google|whatsapp|telegram|email|tools|vpn|backups|security|test)\.[a-z_0-9]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) expect(en).toHaveProperty(`d.${key}`);
  });

  it("fills in parameters", () => {
    expect(translate("en", "d.model.done", { provider: "OpenRouter" })).toBe("OpenRouter key is saved.");
    expect(translate("zh-Hant", "ofReady", { total: 11 })).toBe("/ 11 項已就緒");
  });
});

describe("GetReadyView", () => {
  it("shows only the groups the person has, and their status", () => {
    render(<GetReadyView initial={response([item({})])} extras={EXTRAS} />);
    expect(screen.getByText("Your connections (each person sets up their own)")).toBeTruthy();
    expect(screen.queryByText("Basics")).toBeNull();
    expect(screen.getAllByText("Not started").length).toBeGreaterThan(0);
  });

  it("shows a busy, disabled Test button until the check returns", async () => {
    let finish: (value: Response) => void = () => undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    render(<GetReadyView initial={response([item({})])} extras={EXTRAS} />);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const busy = await screen.findByRole("button", { name: /Testing/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/get-ready/vpn/test", expect.objectContaining({ method: "POST" }));

    const done = item({
      status: "done",
      detail: "vpn.done",
      params: { folders: 2 },
      last_test: { at: "2026-10-19T10:00:00Z", result: "ok", detail: "vpn.done", params: { folders: 2 } },
    });
    finish(new Response(JSON.stringify(done), { status: 200 }));
    await waitFor(() => expect(screen.getAllByText("2 network folder(s) added.").length).toBe(2));
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
  });
});

describe("PeopleAndRoles", () => {
  it("shows status words only, never anything else from the row", () => {
    const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
    expect(cellText(t, { state: "waiting", reason: "step_a" })).toBe("waits for step A");
    expect(cellText(t, { state: "set", count: 3 })).toBe("3 tools");
    expect(cellText(t, { state: "not_set" })).toBe("not set");
  });

  it("renders the role table and each person's connections", () => {
    const connections = { state: "not_set" as const };
    render(
      <PeopleAndRoles
        profile="default"
        peopleError={null}
        people={{
          connections: ["google", "vpn"],
          people: [
            {
              user_id: "u1",
              display: "Mary",
              role: "member",
              is_you: false,
              invited_pending: true,
              connections: {
                google: { state: "waiting", reason: "step_a" },
                whatsapp: connections,
                telegram: connections,
                email: connections,
                tools: connections,
                vpn: { state: "set" },
              },
            },
          ],
        }}
      />,
    );
    expect(screen.getAllByText("Mary").length).toBe(2);
    expect(screen.getAllByText("waits for step A").length).toBe(2);
    expect(screen.getAllByRole("separator").length).toBeGreaterThan(0);
  });
});

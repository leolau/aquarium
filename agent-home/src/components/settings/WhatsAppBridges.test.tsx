// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WhatsAppBridges,
  bridgeStatus,
  whatsAppItemState,
} from "@/components/settings/WhatsAppBridges";
import { pickLang, translate } from "@/components/settings/whatsappStrings";
import en from "@/i18n/messages/en/whatsapp.json";
import zhHant from "@/i18n/messages/zh-Hant/whatsapp.json";
import type { WaBridge } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function bridge(over: Partial<WaBridge> = {}): WaBridge {
  return {
    name: "amy",
    unit: "hermes-wa-bridge-amy.service",
    active: "active",
    paired: true,
    qr_pending: false,
    qr_age_seconds: null,
    qr_stale: false,
    status: "connected",
    number: "+852****5432",
    ...over,
  };
}

function mockFetch(list: unknown, extra: Record<string, () => Response> = {}) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push([url, init]);
    for (const [prefix, make] of Object.entries(extra)) {
      if (url === prefix) return make();
    }
    return new Response(JSON.stringify(list));
  });
  return calls;
}

describe("WhatsAppBridges", () => {
  it("sends the test to the bridge's own number and shows where it went", async () => {
    const calls = mockFetch(
      { bridges: [bridge()], others: [], can_add: true },
      {
        "/api/wa-bridges/amy/test": () =>
          new Response(JSON.stringify({ sent: true, to: "+852****5432" })),
      },
    );
    render(<WhatsAppBridges />);
    await screen.findByText(/sends to this phone's own number \+852\*\*\*\*5432/);
    const send = screen.getByRole("button", { name: "Send test" });
    fireEvent.click(send);
    await screen.findByRole("status");
    const testCall = calls.find(([u]) => u === "/api/wa-bridges/amy/test");
    expect(testCall?.[1]?.method).toBe("POST");
    expect(testCall?.[1]?.body).toBeUndefined();
    expect(screen.getByRole("status").textContent).toContain("+852****5432");
  });

  it("keeps Send test off until the phone is linked", async () => {
    mockFetch({
      bridges: [bridge({ paired: false, qr_pending: true, status: "waiting_for_qr", number: null })],
    });
    render(<WhatsAppBridges />);
    await screen.findByText("waiting for QR scan");
    const send = screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Available after the phone is linked.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show QR" })).toBeTruthy();
  });

  it("shows other people's bridges as a status only", async () => {
    mockFetch({
      bridges: [],
      others: [{ name: "amy", person: "amy", person_display: "Amy Chan", status: "waiting_for_qr" }],
    });
    render(<WhatsAppBridges />);
    const table = await screen.findByTestId("wa-others");
    expect(table.textContent).toContain("Amy Chan");
    expect(table.textContent).toContain("waiting for QR scan");
    expect(table.querySelector("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show QR" })).toBeNull();
  });

  it("blocks repeat clicks while adding", async () => {
    let release: (r: Response) => void = () => {};
    mockFetch({ bridges: [] }, {});
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/wa-bridges" && init?.method === "POST") {
        return new Promise<Response>((r) => (release = r));
      }
      return new Response(JSON.stringify({ bridges: [] }));
    });
    render(<WhatsAppBridges />);
    fireEvent.change(await screen.findByLabelText("new bridge name (e.g. work)"), {
      target: { value: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add bridge" }));
    const busy = (await screen.findByRole("button", { name: "Adding…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    release(new Response(JSON.stringify({ bridge: bridge({ name: "work" }) })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Adding…" })).toBeNull());
  });
});

describe("helpers", () => {
  it("derives the Get ready item state", () => {
    expect(whatsAppItemState([])).toBe("not_started");
    expect(whatsAppItemState([bridge({ status: "waiting_for_qr" })])).toBe("attention");
    expect(whatsAppItemState([bridge()])).toBe("done");
    expect(bridgeStatus(bridge({ status: undefined, active: "failed" }))).toBe("failed");
  });

  it("has every string in both languages", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
    expect(pickLang("zh-Hant")).toBe("zh-Hant");
    expect(pickLang("en")).toBe("en");
    expect(translate("zh-Hant", "step3")).toBe("向自己發送測試訊息");
    expect(translate("en", "qrAge", { seconds: 12 })).toContain("12s");
  });
});

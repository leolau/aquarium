// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoogleClientSetup } from "@/components/settings/GoogleClientSetup";
import { pickLocale, translate } from "@/components/settings/googleClientStrings";
import en from "@/i18n/messages/en/googleClient.json";
import zhHant from "@/i18n/messages/zh-Hant/googleClient.json";
import type { GoogleClientStatus } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function status(over: Partial<GoogleClientStatus> = {}): GoogleClientStatus {
  return {
    configured: false,
    source: null,
    client_type: null,
    client_id_hint: null,
    steps: { "1": true, "2": true, "3": false, "4": false, "5": false },
    last_check: null,
    scopes: ["openid", "https://mail.google.com/"],
    redirect_uri: "http://localhost:4321",
    ...over,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const out = handler(String(input), init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  });
}

describe("GoogleClientSetup", () => {
  it("guides through the six steps and counts the owner's ticks", async () => {
    mockFetch(() => status());
    render(<GoogleClientSetup />);
    expect(await screen.findByText("2 of 6 steps done")).toBeTruthy();
    expect(screen.getByText(/https:\/\/mail\.google\.com\//)).toBeTruthy();
    expect(screen.getByText("http://localhost:4321")).toBeTruthy();
    expect(screen.getByText(en.stepBLocked)).toBeTruthy();
  });

  it("stores a tick on the server", async () => {
    const fetchSpy = mockFetch((url) =>
      url.endsWith("/steps")
        ? status({ steps: { "1": true, "2": true, "3": true, "4": false, "5": false } })
        : status(),
    );
    render(<GoogleClientSetup />);
    fireEvent.click(await screen.findByLabelText("Mark step 3 done"));
    await screen.findByText("3 of 6 steps done");
    const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith("/steps"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ steps: { "3": true } });
  });

  it("saves pasted values, blocks a second click, then opens step B", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") {
        await gate;
        return new Response(
          JSON.stringify({
            saved: true,
            check: "ok",
            client: status({ configured: true, source: "file", client_type: "installed", client_id_hint: "12345678…" }),
          }),
        );
      }
      return new Response(JSON.stringify(status()));
    });
    render(<GoogleClientSetup />);
    fireEvent.change(await screen.findByPlaceholderText(/apps\.googleusercontent\.com/), {
      target: { value: "1-a.apps.googleusercontent.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("GOCSPX-…"), { target: { value: "GOCSPX-s" } });
    const save = screen.getByRole("button", { name: en.saveAndTest });
    fireEvent.click(save);
    const busy = await screen.findByRole("button", { name: en.checking });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    release();
    expect(await screen.findByText(en.ok)).toBeTruthy();
    expect(fetchSpy.mock.calls.filter(([, i]) => i?.method === "PUT")).toHaveLength(1);
    const body = JSON.parse(String(fetchSpy.mock.calls.find(([, i]) => i?.method === "PUT")?.[1]?.body));
    expect(body).toEqual({ client_id: "1-a.apps.googleusercontent.com", client_secret: "GOCSPX-s", replace: false });
    expect(screen.getByRole("link", { name: en.stepBLink }).getAttribute("href")).toBe("#connected-accounts");
  });

  it("explains a client Google rejects", async () => {
    mockFetch((_url, init) =>
      init?.method === "PUT" ? { saved: false, check: "invalid_client", client: status() } : status(),
    );
    render(<GoogleClientSetup />);
    fireEvent.change(await screen.findByPlaceholderText(/apps\.googleusercontent\.com/), {
      target: { value: "1-a.apps.googleusercontent.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("GOCSPX-…"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: en.saveAndTest }));
    expect(await screen.findByText(en.err_invalid_client)).toBeTruthy();
  });

  it("shows an existing client as done and replaces it only on request", async () => {
    const fetchSpy = mockFetch((_url, init) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ detail: "bad_client_id" }), { status: 400 })
        : status({ configured: true, source: "env", client_type: "unknown", client_id_hint: "12345678…" }),
    );
    render(<GoogleClientSetup />);
    expect(await screen.findByText(`✓ ${en.doneTitle}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.saveAndTest })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.replace }));
    fireEvent.change(screen.getByPlaceholderText(/apps\.googleusercontent\.com/), { target: { value: "nope" } });
    fireEvent.change(screen.getByPlaceholderText("GOCSPX-…"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: en.saveAndTest }));
    expect(await screen.findByText(en.err_bad_client_id)).toBeTruthy();
    const put = fetchSpy.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body)).replace).toBe(true);
  });

  it("sends an uploaded client file as-is", async () => {
    const fetchSpy = mockFetch((_url, init) =>
      init?.method === "PUT" ? { saved: true, check: "ok", client: status({ configured: true }) } : status(),
    );
    render(<GoogleClientSetup />);
    const doc = '{"installed":{"client_id":"1-a.apps.googleusercontent.com","client_secret":"s"}}';
    const input = (await screen.findByTestId("google-client-file")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([doc], "client_secret_1.json")] } });
    await screen.findByText("File ready: client_secret_1.json");
    fireEvent.click(screen.getByRole("button", { name: en.saveAndTest }));
    await waitFor(() => expect(fetchSpy.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(true));
    const put = fetchSpy.mock.calls.find(([, i]) => i?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ client_json: doc, replace: false });
  });
});

describe("googleClient strings", () => {
  it("has every English string in Traditional Chinese", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });

  it("picks zh-Hant for Chinese browsers and fills placeholders", () => {
    expect(pickLocale(["zh-HK", "en"])).toBe("zh-Hant");
    expect(pickLocale(["en-GB"])).toBe("en");
    expect(translate("zh-Hant", "progress", { done: 2 })).toBe("6 個步驟中已完成 2 個");
  });
});

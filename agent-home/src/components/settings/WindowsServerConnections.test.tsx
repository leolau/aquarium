// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WindowsServerConnections,
  toWinrmInput,
  type WinrmFormValues,
} from "@/components/settings/WindowsServerConnections";
import type { WinrmConnection } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function connection(over: Partial<WinrmConnection> = {}): WinrmConnection {
  return {
    name: "APP01", label: "", host: "app01.corp.example", port: 5986, transport: "ntlm",
    username: "CORP\\ops", verify_tls: true, legacy_tls: false, vpn: "", password_set: true,
    state: "untested", last_test: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE: WinrmFormValues = {
  name: "APP01", host: "app01", port: "5986", transport: "ntlm", username: "CORP\\ops",
  password: "pw", verify_tls: false, legacy_tls: true, vpn: "",
};

describe("toWinrmInput", () => {
  it("builds the body with a numeric port and keeps an empty password on edit", () => {
    const out = toWinrmInput(BASE, false);
    expect("body" in out && out.body).toMatchObject({
      port: 5986, transport: "ntlm", verify_tls: false, legacy_tls: true, password: "pw",
    });
    const edit = toWinrmInput({ ...BASE, password: "" }, true);
    expect("body" in edit && "password" in edit.body).toBe(false);
    expect(toWinrmInput({ ...BASE, password: "" }, false)).toEqual({ problem: "errPassword" });
  });
  it("drops the TLS options over HTTP", () => {
    const out = toWinrmInput({ ...BASE, port: "5985" }, false);
    expect("body" in out && out.body).toMatchObject({ port: 5985, verify_tls: true, legacy_tls: false });
  });
  it("rejects bad names and missing fields", () => {
    expect(toWinrmInput({ ...BASE, name: "../x" }, false)).toEqual({ problem: "errName" });
    expect(toWinrmInput({ ...BASE, username: " " }, false)).toEqual({ problem: "errRequired" });
  });
});

describe("WindowsServerConnections", () => {
  it("saves through the VPN then tests, and shows the computer and PowerShell version", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init]);
      if (String(url) === "/api/vpn") return json({ vpns: [{ name: "Office VPN", status: { state: "disconnected" } }] });
      if (init?.method === "PUT") return json({ connection: connection({ vpn: "Office VPN", transport: "credssp" }) });
      if (init?.method === "POST") {
        return json({
          connection: connection({
            vpn: "Office VPN", transport: "credssp", state: "working",
            last_test: { at: "2026-11-02T10:00:00Z", ok: true, ps_version: "5.1.17763.1", computer_name: "APP01" },
          }),
        });
      }
      return json({ connections: [], driver_available: true });
    });
    render(<WindowsServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Windows server" }));
    fireEvent.change(screen.getByPlaceholderText("APP01"), { target: { value: "APP01" } });
    fireEvent.change(screen.getByLabelText("Server"), { target: { value: "app01.corp.example" } });
    fireEvent.change(screen.getByLabelText("Windows user (DOMAIN\\user)"), { target: { value: "CORP\\ops" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.change(screen.getByLabelText("Sign-in method"), { target: { value: "credssp" } });
    await screen.findByRole("option", { name: "Office VPN" });
    fireEvent.change(screen.getByLabelText("Reach it through VPN"), { target: { value: "Office VPN" } });
    fireEvent.click(screen.getByLabelText("Older Windows Server 2008/2012 (TLS 1.0)"));
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    await screen.findByText("Working");
    const put = calls.find(([, i]) => i?.method === "PUT");
    expect(put?.[0]).toBe("/api/winrm/connections/APP01");
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      host: "app01.corp.example", port: 5986, transport: "credssp", username: "CORP\\ops",
      password: "s3cret", vpn: "Office VPN", verify_tls: true, legacy_tls: true,
    });
    expect(calls.some(([u, i]) => u === "/api/winrm/connections/APP01/test" && i?.method === "POST")).toBe(true);
    expect(screen.getByText("Signed in: APP01, PowerShell 5.1.17763.1")).toBeTruthy();
  });

  it("hides the certificate options over HTTP", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "/api/vpn" ? json({ vpns: [] }) : json({ connections: [], driver_available: true }),
    );
    render(<WindowsServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Windows server" }));
    expect(screen.getByLabelText(/Check the server certificate/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "5985" } });
    expect(screen.queryByLabelText(/Check the server certificate/)).toBeNull();
  });

  it("tests a saved server, shows failures in plain words, never prefills the password", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        return json({
          connection: connection({
            state: "needs_attention",
            last_test: { at: "x", ok: false, error: "Sign-in failed: check the user name." },
          }),
        });
      }
      if (String(url) === "/api/vpn") return json({ vpns: [] });
      return json({ connections: [connection()], driver_available: true });
    });
    render(<WindowsServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    await screen.findByText("Needs attention");
    expect(screen.getByText("Sign-in failed: check the user name.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
    expect(screen.getByText("Leave empty to keep the saved password.")).toBeTruthy();
  });

  it("says when the server has no PowerShell driver", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "/api/vpn" ? json({ vpns: [] }) : json({ connections: [], driver_available: false }),
    );
    render(<WindowsServerConnections />);
    await screen.findByText(/Windows PowerShell support is not installed/);
  });
});

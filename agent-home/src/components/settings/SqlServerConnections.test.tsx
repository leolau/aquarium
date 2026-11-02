// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlServerConnections, toSqlInput, type SqlFormValues } from "@/components/settings/SqlServerConnections";
import type { MssqlConnection } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function connection(over: Partial<MssqlConnection> = {}): MssqlConnection {
  return {
    name: "ERP", label: "", host: "sql01.corp.example", port: 1433, instance: "", database: "Sales",
    username: "reader", encrypt: "on", trust_server_certificate: false, legacy_tls: false, vpn: "",
    allow_writes: false, password_set: true, state: "untested", last_test: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE: SqlFormValues = {
  name: "ERP", host: "sql01", port: "1433", instance: "", database: "Sales", username: "reader",
  password: "pw", encrypt: "on", trust_server_certificate: false, legacy_tls: true, vpn: "",
  allow_writes: true,
};

describe("toSqlInput", () => {
  it("builds the body with a numeric port and keeps an empty password on edit", () => {
    const out = toSqlInput(BASE, false, true);
    expect("body" in out && out.body).toMatchObject({ port: 1433, legacy_tls: true, password: "pw", allow_writes: true });
    const edit = toSqlInput({ ...BASE, password: "" }, true, true);
    expect("body" in edit && "password" in edit.body).toBe(false);
    expect(toSqlInput({ ...BASE, password: "" }, false, true)).toEqual({ problem: "errPassword" });
  });
  it("never sends allow_writes for a member", () => {
    const out = toSqlInput(BASE, false, false);
    expect("body" in out && "allow_writes" in out.body).toBe(false);
  });
  it("rejects bad ports, names and missing fields", () => {
    expect(toSqlInput({ ...BASE, port: "0" }, false, false)).toEqual({ problem: "errPort" });
    expect(toSqlInput({ ...BASE, port: "", instance: "SQLEXPRESS" }, false, false)).not.toHaveProperty("problem");
    expect(toSqlInput({ ...BASE, name: "../x" }, false, false)).toEqual({ problem: "errName" });
    expect(toSqlInput({ ...BASE, database: " " }, false, false)).toEqual({ problem: "errRequired" });
  });
});

function mockFetch(calls: Array<[string, RequestInit | undefined]>, list: MssqlConnection[] = []) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url) === "/api/vpn") return json({ vpns: [{ name: "Office VPN", status: { state: "disconnected" } }] });
    if (init?.method === "PUT") return json({ connection: connection({ vpn: "Office VPN" }) });
    if (init?.method === "POST") {
      return json({
        connection: connection({
          vpn: "Office VPN",
          state: "working",
          last_test: { at: "2026-11-02T10:00:00Z", ok: true, server_version: "Microsoft SQL Server 2012 (SP4)\nx", database: "Sales" },
        }),
      });
    }
    return json({ connections: list, driver_available: true });
  });
}

describe("SqlServerConnections", () => {
  it("saves through the VPN then tests, and shows the server version", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockFetch(calls);
    render(<SqlServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    fireEvent.change(screen.getByPlaceholderText("ERP"), { target: { value: "ERP" } });
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "Sales" } });
    fireEvent.change(screen.getByLabelText("Server"), { target: { value: "sql01.corp.example" } });
    fireEvent.change(screen.getByLabelText("SQL login"), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    await screen.findByRole("option", { name: "Office VPN" });
    fireEvent.change(screen.getByLabelText("Reach it through VPN"), { target: { value: "Office VPN" } });
    fireEvent.click(screen.getByLabelText("Older Windows Server 2008/2012 (TLS 1.0)"));
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    await screen.findByText("Working");
    const put = calls.find(([, i]) => i?.method === "PUT");
    expect(put?.[0]).toBe("/api/mssql/connections/ERP");
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      host: "sql01.corp.example", port: 1433, database: "Sales", username: "reader",
      password: "s3cret", vpn: "Office VPN", legacy_tls: true, encrypt: "on",
    });
    expect(calls.some(([u, i]) => u === "/api/mssql/connections/ERP/test" && i?.method === "POST")).toBe(true);
    expect(screen.getByText("Signed in: Microsoft SQL Server 2012 (SP4)")).toBeTruthy();
  });

  it("hides the Allow changes switch from members and shows it to the owner", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockFetch(calls);
    render(<SqlServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    expect(screen.queryByLabelText("Allow changes (each change asks you first)")).toBeNull();
    cleanup();
    render(<SqlServerConnections isOwner />);
    fireEvent.click(await screen.findByRole("button", { name: "Add database" }));
    expect(screen.getByLabelText("Allow changes (each change asks you first)")).toBeTruthy();
  });

  it("tests a saved connection, shows failures in plain words, never prefills the password", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init]);
      if (init?.method === "POST") {
        return json({
          connection: connection({
            state: "needs_attention",
            last_test: { at: "x", ok: false, error: "Sign-in failed: check the SQL login and password." },
          }),
        });
      }
      if (String(url) === "/api/vpn") return json({ vpns: [] });
      return json({ connections: [connection()], driver_available: true });
    });
    render(<SqlServerConnections />);
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    await screen.findByText("Needs attention");
    expect(screen.getByText("Sign-in failed: check the SQL login and password.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
    expect(screen.getByText("Leave empty to keep the saved password.")).toBeTruthy();
  });

  it("says when the server has no SQL Server driver", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url) === "/api/vpn" ? json({ vpns: [] }) : json({ connections: [], driver_available: false }),
    );
    render(<SqlServerConnections />);
    await screen.findByText(/SQL Server support is not installed/);
  });
});

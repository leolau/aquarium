// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmailMailboxes, toInput } from "@/components/settings/EmailMailboxes";
import type { EmailMailbox } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mailbox(over: Partial<EmailMailbox> = {}): EmailMailbox {
  return {
    address: "alice@example.com",
    username: "alice@example.com",
    preset: "other",
    imap_host: "imap.example.com", imap_port: 993, imap_security: "ssl",
    smtp_host: "smtp.example.com", smtp_port: 465, smtp_security: "ssl",
    password_set: true,
    state: "untested",
    last_test: null,
    last_poll: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE = {
  address: "a@b.com", username: "a", password: "pw", preset: "other" as const,
  imap_host: "imap.b.com", imap_port: "993", imap_security: "ssl" as const,
  smtp_host: "smtp.b.com", smtp_port: "465", smtp_security: "ssl" as const,
};

describe("toInput", () => {
  it("builds the body with numeric ports", () => {
    const out = toInput(BASE, false);
    expect("body" in out && out.body.imap_port).toBe(993);
  });
  it("requires a password for a new mailbox but not when editing", () => {
    expect(toInput({ ...BASE, password: "" }, false)).toEqual({ problem: "errPassword" });
    const edit = toInput({ ...BASE, password: "" }, true);
    expect("body" in edit && "password" in edit.body).toBe(false);
  });
  it("rejects bad ports and missing fields", () => {
    expect(toInput({ ...BASE, smtp_port: "0" }, false)).toEqual({ problem: "errPort" });
    expect(toInput({ ...BASE, imap_host: " " }, false)).toEqual({ problem: "errRequired" });
  });
});

describe("EmailMailboxes", () => {
  it("shows the inline form when there is no mailbox, fills presets, saves then tests", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init]);
      if (init?.method === "PUT") return json({ mailbox: mailbox({ preset: "outlook" }) });
      if (init?.method === "POST") {
        return json({
          mailbox: mailbox({
            state: "working",
            last_test: { at: "2026-10-19T10:00:00Z", ok: true, imap: { ok: true }, smtp: { ok: true } },
          }),
        });
      }
      return json({ mailboxes: [] });
    });
    render(<EmailMailboxes />);
    const address = await screen.findByPlaceholderText("info@yourcompany.com");
    fireEvent.change(address, { target: { value: "Alice@Example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Outlook / Microsoft 365" }));
    expect(screen.getByLabelText("Outgoing server (SMTP)")).toHaveProperty("value", "smtp.office365.com");
    fireEvent.change(screen.getByLabelText("Password or app password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    await screen.findByText("Working");
    const put = calls.find(([, i]) => i?.method === "PUT");
    expect(put?.[0]).toBe("/api/email/mailboxes/alice%40example.com");
    const body = JSON.parse(String(put?.[1]?.body));
    expect(body).toMatchObject({ smtp_port: 587, smtp_security: "starttls", password: "s3cret", preset: "outlook" });
    expect(calls.some(([u, i]) => u.endsWith("/test") && i?.method === "POST")).toBe(true);
    expect(screen.getByText("Outgoing mail: signed in (nothing was sent).")).toBeTruthy();
  });

  it("lists failures in plain words and never shows a password field value", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        mailboxes: [
          mailbox({
            state: "needs_attention",
            last_test: {
              at: "2026-10-19T10:00:00Z", ok: false,
              imap: { ok: false, error: "Sign-in failed: check the user name and password (or app password)." },
              smtp: { ok: true },
            },
          }),
        ],
      }),
    );
    render(<EmailMailboxes />);
    await screen.findByText("Needs attention");
    expect(screen.getByText(/Incoming mail: Sign-in failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Password or app password")).toHaveProperty("value", "");
    expect(screen.getByText("Leave empty to keep the saved password.")).toBeTruthy();
  });

  it("blocks repeat clicks while testing", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return new Promise<Response>((r) => (release = r));
      return json({ mailboxes: [mailbox()] });
    });
    render(<EmailMailboxes />);
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    const busyBtn = await screen.findByRole("button", { name: "Testing…" });
    expect(busyBtn).toHaveProperty("disabled", true);
    fireEvent.click(busyBtn);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
    release(json({ mailbox: mailbox({ state: "working" }) }));
    await waitFor(() => expect(screen.getByText("Working")).toBeTruthy());
  });
});

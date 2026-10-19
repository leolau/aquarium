// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackupsItem, overallOf } from "@/components/get-ready/BackupsItem";
import en from "@/i18n/messages/en/backups.json";
import zh from "@/i18n/messages/zh-Hant/backups.json";
import type { OffsiteBackupStatus } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EMPTY: OffsiteBackupStatus = { available: true, configured: false, state: "not_configured" };
const TARGET = {
  provider: "b2" as const,
  bucket: "acme-backup",
  prefix: "aquarium",
  endpoint: "https://s3.eu-central-003.backblazeb2.com",
  region: "eu-central-003",
  key_id_hint: "…1234",
};
const READY: OffsiteBackupStatus = {
  ...EMPTY,
  configured: true,
  state: "needs_first_backup",
  target: TARGET,
  schedule: { enabled: true, time: "03:00", keep_days: 30 },
  key_exists: true,
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const result = handler(String(input), init);
    const status = result instanceof Response ? result.status : 200;
    const body = result instanceof Response ? await result.text() : JSON.stringify(result);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
}

describe("BackupsItem", () => {
  it("has the same strings in English and Traditional Chinese", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("maps states to the checklist status", () => {
    expect(overallOf("ok")).toBe("done");
    expect(overallOf("not_configured")).toBe("notStarted");
    expect(overallOf("unavailable")).toBe("notStarted");
    expect(overallOf("needs_restore_test")).toBe("attention");
  });

  it("shows the mockup form and keeps the job buttons off before setup", () => {
    render(<BackupsItem initial={EMPTY} defaultOpen />);
    expect(screen.getByText(en.stateNotConfigured)).toBeTruthy();
    expect(screen.getByText(en.intro)).toBeTruthy();
    expect(screen.getByText("Every night at 03:00, keep 30 days")).toBeTruthy();
    expect((screen.getByText(en.firstBackup) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(en.restoreTest) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(en.restoreNote)).toBeTruthy();
  });

  it("asks for the storage address only for other storage", () => {
    render(<BackupsItem initial={EMPTY} defaultOpen />);
    expect(screen.queryByText(en.endpoint)).toBeNull();
    fireEvent.change(screen.getByLabelText(en.where), { target: { value: "other" } });
    expect(screen.getByText(en.endpoint)).toBeTruthy();
  });

  it("saves once, blocks repeat clicks, shows the key once and clears the secret", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ status: READY, new_key: "KEY-ONCE-123" }), { status: 200 });
    });
    render(<BackupsItem initial={EMPTY} defaultOpen />);
    fireEvent.change(screen.getByLabelText(en.bucket), { target: { value: "acme-backup" } });
    fireEvent.change(screen.getByLabelText(en.keyId), { target: { value: "0031234" } });
    fireEvent.change(screen.getByLabelText(en.secret), { target: { value: "K003secret" } });
    fireEvent.click(screen.getByText(en.saveTest));
    expect(screen.getByText(en.testing)).toBeTruthy();
    fireEvent.click(screen.getByText(en.testing));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ provider: "b2", bucket: "acme-backup", key_id: "0031234", secret: "K003secret", time: "03:00", keep_days: 30 });
    release();
    await waitFor(() => expect(screen.getByText("KEY-ONCE-123")).toBeTruthy());
    expect((screen.getByLabelText(en.secret) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(en.stateNeedsFirstBackup)).toBeTruthy();
    expect((screen.getByText(en.firstBackup) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(en.keySaved));
    fireEvent.click(screen.getAllByText(en.close).at(-1)!);
    expect(screen.queryByText("KEY-ONCE-123")).toBeNull();
  });

  it("shows a server error in place", async () => {
    mockFetch(() => new Response(JSON.stringify({ detail: "the bucket was not found" }), { status: 400 }));
    render(<BackupsItem initial={EMPTY} defaultOpen />);
    fireEvent.change(screen.getByLabelText(en.bucket), { target: { value: "nope-bucket" } });
    fireEvent.change(screen.getByLabelText(en.keyId), { target: { value: "0031234" } });
    fireEvent.change(screen.getByLabelText(en.secret), { target: { value: "s" } });
    fireEvent.click(screen.getByText(en.saveTest));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("the bucket was not found"));
  });

  it("shows progress while a backup runs and disables the buttons", async () => {
    const running: OffsiteBackupStatus = {
      ...READY,
      state: "running",
      running: { kind: "backup", phase: "uploading", percent: 72, started: "2026-10-19T03:00:00Z" },
    };
    mockFetch((_url, init) => (init?.method === "POST" ? { started: true, status: running } : running));
    render(<BackupsItem initial={READY} defaultOpen />);
    fireEvent.click(screen.getByText(en.firstBackup));
    await waitFor(() => expect(screen.getByTestId("backups-progress")).toBeTruthy());
    expect(screen.getByText(en.phase_uploading)).toBeTruthy();
    expect(screen.getByText("72%")).toBeTruthy();
    expect((screen.getByText(en.saveTest) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText(en.restoreTest).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the last good backup and last restore test, in Chinese too", () => {
    const ok: OffsiteBackupStatus = {
      ...READY,
      state: "ok",
      last_good_backup: { at: "2026-10-19T03:00:05Z", ok: true, size: 5 * 1024 * 1024 },
      last_restore_test: { at: "2026-10-19T03:20:00Z", ok: true },
      copies: 3,
    };
    render(<BackupsItem initial={ok} lang="zh-Hant" defaultOpen />);
    expect(screen.getByText(zh.stateOk)).toBeTruthy();
    expect(screen.getByText(zh.done)).toBeTruthy();
    expect(screen.getByText(/最近成功備份：.*（5\.0 MB）/)).toBeTruthy();
    expect(screen.getByText(/最近還原測試：.*，通過/)).toBeTruthy();
    expect(screen.getByText(zh.backupNow)).toBeTruthy();
    expect(document.body.textContent).not.toContain("K003");
  });

  it("explains when this server cannot manage backups yet", () => {
    render(<BackupsItem initial={{ available: false, configured: false, state: "unavailable" }} defaultOpen />);
    expect(screen.getByText(en.unavailable)).toBeTruthy();
    expect(screen.queryByText(en.saveTest)).toBeNull();
  });
});

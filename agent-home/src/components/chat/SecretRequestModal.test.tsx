// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import { SecretRequestModal } from "@/components/chat/SecretRequestModal";
import { SecretSubmitError } from "@/lib/chat/secret-prompt";
import type { ChatSecretRequest } from "@/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const REQUEST: ChatSecretRequest = {
  requestId: "sr_0123456789abcdef",
  name: "github-pat",
  label: "GitHub personal access token",
  purpose: "Push the fix to leolau/aquarium",
  kind: "secret",
  username: null,
  expiresAt: null,
};

const valueInput = () => document.querySelector<HTMLInputElement>('input[name$="-value-masked"]')!;

describe("SecretRequestModal (request mode)", () => {
  it("shows the label, purpose and name with a masked, autofill-free field", () => {
    render(<SecretRequestModal mode="request" request={REQUEST} onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("GitHub personal access token")).toBeTruthy();
    expect(screen.getByText("Push the fix to leolau/aquarium")).toBeTruthy();
    expect(screen.getByText("github-pat")).toBeTruthy();
    const input = valueInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("toggles show/hide", () => {
    render(<SecretRequestModal mode="request" request={REQUEST} onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(valueInput().type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(valueInput().type).toBe("password");
  });

  it("submits the value and clears the field before the send resolves", async () => {
    let finish: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<SecretRequestModal mode="request" request={REQUEST} onSubmit={onSubmit} onDismiss={vi.fn()} />);
    fireEvent.change(valueInput(), { target: { value: "ghp_pasted\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit securely" }));
    expect(onSubmit).toHaveBeenCalledWith({ value: "ghp_pasted" }, "github-pat");
    expect(valueInput().value).toBe("");
    await act(async () => finish());
  });

  it("sends username + password for a password request with the username prefilled", () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <SecretRequestModal
        mode="request"
        request={{ ...REQUEST, kind: "password", name: "erp", username: "mia" }}
        onSubmit={onSubmit}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("mia")).toBeTruthy();
    fireEvent.change(valueInput(), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit securely" }));
    expect(onSubmit).toHaveBeenCalledWith({ username: "mia", password: "hunter22" }, "erp");
  });

  it("Esc keeps the request pending (dismiss, not decline)", () => {
    const onDismiss = vi.fn();
    const onDecline = vi.fn(async () => {});
    render(
      <SecretRequestModal mode="request" request={REQUEST} onSubmit={vi.fn()} onDecline={onDecline} onDismiss={onDismiss} />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("declines explicitly", () => {
    const onDecline = vi.fn(async () => {});
    render(
      <SecretRequestModal mode="request" request={REQUEST} onSubmit={vi.fn()} onDecline={onDecline} onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog", () => {
    render(<SecretRequestModal mode="request" request={REQUEST} onSubmit={vi.fn()} onDecline={vi.fn()} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const last = screen.getByRole("button", { name: "Not now" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(valueInput());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("shows a translated error, never the value", async () => {
    const onSubmit = vi.fn(async () => {
      throw new SecretSubmitError("answered");
    });
    render(<SecretRequestModal mode="request" request={REQUEST} onSubmit={onSubmit} onDismiss={vi.fn()} />);
    fireEvent.change(valueInput(), { target: { value: "top-secret-value" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit securely" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/already answered/);
    expect(document.body.textContent).not.toContain("top-secret-value");
  });

  it("counts down and blocks submit once expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000_000));
    render(
      <SecretRequestModal
        mode="request"
        request={{ ...REQUEST, expiresAt: 1_000_000_000 + 65 }}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("secret-countdown").textContent).toContain("1:05");
    act(() => {
      vi.advanceTimersByTime(66_000);
    });
    expect(screen.getByTestId("secret-countdown").textContent).toMatch(/expired/);
    expect(screen.queryByRole("button", { name: "Submit securely" })).toBeNull();
  });
});

describe("SecretRequestModal (save mode)", () => {
  it("needs a valid name and passes it with the value", () => {
    const onSubmit = vi.fn(async () => {});
    render(<SecretRequestModal mode="save" onSubmit={onSubmit} onDismiss={vi.fn()} />);
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "My Token" } });
    expect(name.value).toBe("my-token");
    fireEvent.change(valueInput(), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    expect(onSubmit).toHaveBeenCalledWith({ value: "s3cret" }, "my-token");
  });
});

describe("Composer secret handling", () => {
  const composer = () => (
    <Composer sending={false} storageEnabled={false} sessionId={null} onSend={vi.fn()} />
  );
  const box = () => screen.getByPlaceholderText(/Message your agent/) as HTMLTextAreaElement;
  const token = `ghp_${"aB3xK9mQ2pZ7wR5tY8uL4nV6cJ1hG0fDaB3x"}`;

  it("warns about a pasted secret and moves it into the popup, then inserts a reference", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(composer());
    fireEvent.change(box(), { target: { value: `push with ${token} please` } });
    expect(screen.getByText(/looks like a secret \(GitHub token\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to secure box" }));
    expect(box().value).toBe("push with please");
    expect(valueInput().value).toBe(token);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/credentials/secret/github-pat");
    expect(JSON.parse(init.body as string).payload).toEqual({ value: token });
    expect(box().value).toBe("push with [secret: github-pat] please");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can keep the text and hide the warning", () => {
    render(composer());
    fireEvent.change(box(), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Keep as text" }));
    expect(screen.queryByText(/looks like a secret/)).toBeNull();
    expect(box().value).toBe(token);
  });

  it("opens the save popup from the lock button", () => {
    render(composer());
    fireEvent.click(screen.getByRole("button", { name: "Share a secret securely" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

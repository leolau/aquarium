// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mou-pack/cards/t_2", useRouter: () => router }));

import { AskOrChangeBox } from "@/components/projects/ask/AskOrChangeBox";
import { storageKey } from "@/components/projects/ask/askThread";
import { askProjectFixture } from "@/components/projects/ask/fixture.test-utils";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ANSWER = {
  answer: "Two MOUs still need the governing-law clause [card:t_2].",
  sources: [
    { kind: "card", id: "t_2", label: "Draft MOU B" },
    { kind: "output", id: "o_1", label: "MOU A.docx" },
  ],
  suggested_requirement: "Add Hong Kong governing law to all four MOUs",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

function setup(props: Partial<Parameters<typeof AskOrChangeBox>[0]> = {}) {
  const onChangeRequest = vi.fn();
  const utils = render(
    <AskOrChangeBox
      project={askProjectFixture()}
      onChangeRequest={onChangeRequest}
      {...props}
    />,
  );
  const textarea = () => utils.container.querySelector("textarea") as HTMLTextAreaElement;
  const askButton = () => screen.getByRole("button", { name: /^(Ask|Asking…)$/ });
  return { ...utils, onChangeRequest, textarea, askButton };
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe("AskOrChangeBox — ask mode", () => {
  it("double click sends one request, shows pending, then the answer with sources", async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const { textarea, askButton, container } = setup();
    fireEvent.change(textarea(), { target: { value: "What's left?" } });
    fireEvent.click(askButton());
    fireEvent.click(askButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/mou-pack/ask");
    expect((init.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBeTruthy();
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ question: "What's left?", history: [] });

    expect(screen.getByText("reading cards, runs and outputs…")).toBeTruthy();
    expect(askButton().textContent).toBe("Asking…");
    expect((askButton() as HTMLButtonElement).disabled).toBe(true);
    expect(textarea().value).toBe("");

    await act(async () => {
      d.resolve(json(200, ANSWER));
    });
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    expect(screen.queryByText("reading cards, runs and outputs…")).toBeNull();
    const card = screen.getByText("Draft MOU B") as HTMLAnchorElement;
    expect(card.getAttribute("href")).toBe("/projects/mou-pack/cards/t_2");
    const output = screen.getByText("MOU A.docx") as HTMLAnchorElement;
    expect(output.getAttribute("href")).toBe("/projects/mou-pack?tab=outputs");
    expect(container.querySelector('[data-turn="done"]')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(askButton().textContent).toBe("Ask");
  });

  it("double Enter sends once; Shift+Enter does not send", async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const { textarea } = setup();
    fireEvent.change(textarea(), { target: { value: "Why?" } });
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    fireEvent.change(textarea(), { target: { value: "Why?" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(json(200, ANSWER));
    });
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
  });

  it("a suggestion chip asks its question", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Why is it slow?" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).question).toBe(
      "Why is it slow? What is it waiting on?",
    );
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
  });

  it("sends earlier answered turns as history", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    fetchMock.mockResolvedValueOnce(json(200, { answer: "Yes.", sources: [] }));
    const { textarea, askButton } = setup();
    fireEvent.change(textarea(), { target: { value: "First?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    fireEvent.change(textarea(), { target: { value: "Second?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByText("Yes.")).toBeTruthy());
    expect(bodyOf(fetchMock.mock.calls[1]).history).toEqual([
      { q: "First?", a: ANSWER.answer },
    ]);
  });

  it("shows a friendly error, re-enables, and retry re-sends the same key", async () => {
    fetchMock.mockResolvedValueOnce(
      json(503, { detail: "The agent couldn't answer just now — try again in a moment." }),
    );
    const { textarea, askButton } = setup();
    fireEvent.change(textarea(), { target: { value: "What's left?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/couldn't answer/));
    expect(askButton().textContent).toBe("Ask");

    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const retry = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key = (c: unknown[]) =>
      ((c[1] as RequestInit).headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    expect(key(fetchMock.mock.calls[1])).toBe(key(fetchMock.mock.calls[0]));
    expect(screen.getByText("reading cards, runs and outputs…")).toBeTruthy();
    await act(async () => {
      d.resolve(json(200, ANSWER));
    });
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Turn into a requirement hands the suggestion to onChangeRequest", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const { textarea, askButton, onChangeRequest } = setup();
    fireEvent.change(textarea(), { target: { value: "What's left?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Turn into a requirement…" }));
    expect(onChangeRequest).toHaveBeenCalledWith(ANSWER.suggested_requirement);
  });

  it("tab sources switch tab in place when onNavigate is given", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const onNavigate = vi.fn();
    const { textarea, askButton } = setup({ onNavigate });
    fireEvent.change(textarea(), { target: { value: "What's left?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByText("MOU A.docx")).toBeTruthy());
    fireEvent.click(screen.getByText("MOU A.docx"));
    expect(onNavigate).toHaveBeenCalledWith("outputs");
  });

  it("persists the thread in sessionStorage and restores it after a remount", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const first = setup();
    fireEvent.change(first.textarea(), { target: { value: "What's left?" } });
    fireEvent.click(first.askButton());
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    expect(window.sessionStorage.getItem(storageKey("mou-pack"))).toContain("t_2");
    first.unmount();

    setup();
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    expect(screen.getByText("Draft MOU B")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Clear empties the thread and its storage", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const { textarea, askButton } = setup();
    fireEvent.change(textarea(), { target: { value: "What's left?" } });
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByText(ANSWER.answer)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(ANSWER.answer)).toBeNull();
    expect(window.sessionStorage.getItem(storageKey("mou-pack"))).toBeNull();
  });

  it("does not send an empty question", () => {
    const { textarea, askButton } = setup();
    fireEvent.change(textarea(), { target: { value: "   " } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect((askButton() as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AskOrChangeBox — change mode", () => {
  it("toggles mode, placeholder and hint", () => {
    const { textarea } = setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ Add requirement / change" }));
    expect(textarea().placeholder).toMatch(/3-year term and Hong Kong governing law/);
    expect(screen.getByRole("button", { name: "Continue ›" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "What's left?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "💬 Ask about this project" }));
    expect(screen.getByRole("button", { name: "What's left?" })).toBeTruthy();
  });

  it("Continue hands over the text with the kind prefix and clears it", () => {
    const { textarea, onChangeRequest } = setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ Add requirement / change" }));
    const chip = screen.getByRole("button", { name: /Change direction/ });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(textarea(), { target: { value: "Focus on the HK partner first" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue ›" }));
    expect(onChangeRequest).toHaveBeenCalledWith("Change direction: Focus on the HK partner first");
    expect(textarea().value).toBe("");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Enter continues; without a kind the text goes over as typed", () => {
    const { textarea, onChangeRequest } = setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ Add requirement / change" }));
    fireEvent.change(textarea(), { target: { value: "Add a 3-year term" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onChangeRequest).toHaveBeenCalledWith("Add a 3-year term");
  });

  it("Continue is disabled with nothing typed or chosen", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ Add requirement / change" }));
    expect(
      (screen.getByRole("button", { name: "Continue ›" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

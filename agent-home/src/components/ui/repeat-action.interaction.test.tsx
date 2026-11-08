// @vitest-environment jsdom
/** A fast double tap / double Enter must send exactly one request. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SurveyForm } from "@/components/seminar/SurveyForm";
import { ConsentForm } from "@/components/webview/ConsentForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function hangingFetch() {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("repeat actions", () => {
  it("SurveyForm posts once on a double submit", async () => {
    const fetchMock = hangingFetch();
    const { container } = render(<SurveyForm token="tok" />);
    const first = (name: string) => container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    fireEvent.click(first("rating"));
    fireEvent.click(first("grades"));
    fireEvent.click(first("share"));
    fireEvent.click(first("next_step"));
    fireEvent.change(first("name"), { target: { value: "Ada" } });
    const form = container.querySelector("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("Webview 'Open session' opens one session on a double tap", () => {
    const onOpen = vi.fn(() => new Promise<void>(() => {}));
    render(<ConsentForm busy={false} onOpen={onOpen} />);
    const btn = screen.getByRole("button", { name: "Open session" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("LanguageSwitch saves once when both languages are tapped quickly", () => {
    const fetchMock = hangingFetch();
    render(<LanguageSwitch />);
    const [en, zh] = screen.getAllByRole("button");
    fireEvent.click(zh);
    fireEvent.click(en);
    fireEvent.click(zh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group").getAttribute("aria-busy")).toBe("true");
  });
});

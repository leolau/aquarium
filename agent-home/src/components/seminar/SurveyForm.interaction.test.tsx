// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurveyLinkInvalid } from "@/components/seminar/SeminarShell";
import { SurveyForm } from "@/components/seminar/SurveyForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pick(container: HTMLElement, name: string) {
  fireEvent.click(container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!);
}

describe("SurveyForm (Figma survey states)", () => {
  it("flags a missing name inline, focuses it and sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<SurveyForm token="tok" />);
    for (const name of ["rating", "grades", "share", "next_step"]) pick(container, name);
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Please enter your name.");
    const input = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const card = input.closest('[role="group"]')!;
    expect(card.getAttribute("data-invalid")).toBe("true");
    expect(card.textContent).toContain("請填寫 Required");
    expect(container.querySelectorAll('[data-invalid="true"]')).toHaveLength(1);

    fireEvent.change(input, { target: { value: "Mrs Chan" } });
    expect(card.getAttribute("data-invalid")).toBeNull();
  });

  it("focuses the first unanswered question when several are missing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<SurveyForm token="tok" />);
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(document.activeElement).toBe(container.querySelector('input[name="rating"]'));
    expect(container.querySelectorAll('[data-invalid="true"]')).toHaveLength(5);
  });

  it("locks every answer and the button while submitting", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<SurveyForm token="tok" />);
    for (const name of ["rating", "grades", "share", "next_step"]) pick(container, name);
    fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: "Ada" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    const button = screen.getByRole("button", { name: /Submitting/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/read-only while sending/)).toBeTruthy();
  });

  it("the invalid-link card has a bilingual title and how to get a new link", () => {
    render(<SurveyLinkInvalid />);
    expect(screen.getByRole("heading", { name: /This survey link is not valid/ })).toBeTruthy();
    expect(screen.getByText(/on WhatsApp again for a new one/)).toBeTruthy();
  });
});

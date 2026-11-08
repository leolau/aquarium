// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { LandingComposer } from "./LandingComposer";
import { chatHandOffUrl, greetingFor } from "./startChat";

const profiles = [
  { name: "default", is_default: true },
  { name: "work", is_default: false },
] as never;

describe("LandingComposer", () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hands the message to a fresh chat on Enter", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "  hello there " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(push).toHaveBeenCalledWith(chatHandOffUrl("hello there")));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("switches profile before starting the chat in another profile", async () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    expect(screen.getByText("Starting in work")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/api/session/profile", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the user on the page when the profile switch is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    render(<LandingComposer profiles={profiles} currentProfile="default" />);
    fireEvent.change(screen.getByLabelText("Profile for the new chat"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("does nothing for an empty message and fills the box from a suggestion", () => {
    render(<LandingComposer profiles={profiles} currentProfile="default" needsYouCount={3} />);
    expect((screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("landing-subline").textContent).toBe("3 things need you");
    fireEvent.click(screen.getByText("What needs my attention?"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("What needs my attention?");
  });

  it("builds the hand-off url and greets by hour", () => {
    expect(chatHandOffUrl("a b")).toBe("/chat?new=1&autosend=1&draft=a+b");
    expect(greetingFor(9)).toBe("Good morning");
    expect(greetingFor(20)).toBe("Good evening");
  });
});

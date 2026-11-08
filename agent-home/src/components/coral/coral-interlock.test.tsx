// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chat/stream", () => ({
  streamChatTurn: vi.fn(),
}));
// CoralHost uses usePathname — mock to a neutral path so no tile is active.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
// Link's useLinkStatus only works inside the App Router's link context.
vi.mock("next/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/link")>();
  return {
    ...actual,
    useLinkStatus: () => ({ pending: false }),
  };
});

import { CoralHost } from "@/components/coral/CoralHost";
import {
  resetCoralInterlockForTests,
} from "@/components/coral/coral-interlock";
import { LeadChatHost } from "@/components/coral/LeadChatHost";

const renderBoth = () =>
  render(
    <>
      <CoralHost />
      <LeadChatHost />
    </>,
  );

const openLeadChat = () =>
  fireEvent.click(screen.getByRole("button", { name: /open lead chat/i }));
const openCoral = () =>
  fireEvent.click(screen.getByRole("button", { name: /open aquarium menu/i }));

beforeEach(() => resetCoralInterlockForTests());

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Coral menu ⇄ lead chat interlock", () => {
  it("opening the menu closes an open lead chat", () => {
    renderBoth();
    openLeadChat();
    expect(screen.getByRole("dialog", { name: /lead chat/i })).toBeTruthy();

    openCoral();
    expect(screen.getByRole("menu", { name: /aquarium launcher/i })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /lead chat/i })).toBeNull();
  });

  it("closing the menu reopens the lead chat it parked (backdrop)", () => {
    renderBoth();
    openLeadChat();
    openCoral();
    expect(screen.queryByRole("dialog", { name: /lead chat/i })).toBeNull();

    fireEvent.click(document.querySelector(".coral-backdrop") as Element);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: /lead chat/i })).toBeTruthy();
  });

  it("closing the menu on Escape reopens the parked lead chat", () => {
    renderBoth();
    openLeadChat();
    openCoral();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: /lead chat/i })).toBeTruthy();
  });

  it("does not open the lead chat if it was closed when the menu opened", () => {
    renderBoth();
    openCoral();
    fireEvent.click(document.querySelector(".coral-backdrop") as Element);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog", { name: /lead chat/i })).toBeNull();
  });
});

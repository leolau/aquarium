// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isSearchShortcut, useSearchShortcut } from "@/lib/chat/search-shortcut";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe("isSearchShortcut", () => {
  it("matches / and Ctrl/Cmd+K outside text fields", () => {
    const e = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(isSearchShortcut(e({ key: "/" }))).toBe(true);
    expect(isSearchShortcut(e({ key: "k", ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(e({ key: "K", metaKey: true }))).toBe(true);
    expect(isSearchShortcut(e({ key: "k" }))).toBe(false);
    expect(isSearchShortcut(e({ key: "/", ctrlKey: true }))).toBe(false);
  });
});

describe("useSearchShortcut", () => {
  it("fires on / from the page body and prevents the default", () => {
    const onTrigger = vi.fn();
    renderHook(() => useSearchShortcut(onTrigger));
    const e = press(document.body, { key: "/" });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    press(document.body, { key: "k", ctrlKey: true });
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("ignores keys typed into inputs, textareas and contenteditable", () => {
    const onTrigger = vi.fn();
    renderHook(() => useSearchShortcut(onTrigger));
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(input, textarea, editable);
    for (const el of [input, textarea, editable]) {
      const e = press(el, { key: "/" });
      expect(e.defaultPrevented).toBe(false);
      press(el, { key: "k", metaKey: true });
    }
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

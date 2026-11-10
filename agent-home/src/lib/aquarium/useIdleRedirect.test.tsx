// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const router = { push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
let pathname = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => pathname,
}));

import { IDLE_SECONDS_DEFAULT } from "./creatures";
import { fetchIdleSeconds, useIdleRedirect } from "./useIdleRedirect";

function Harness({ blocked }: { blocked?: boolean }) {
  useIdleRedirect({ blocked });
  return null;
}

function serve(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(blocked?: boolean) {
  const view = render(<Harness blocked={blocked} />);
  await advance(0);
  return view;
}

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  pathname = "/";
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  push.mockReset();
});

describe("useIdleRedirect", () => {
  it("opens the Aquarium after the configured idle seconds", async () => {
    const f = serve({ idle_seconds: 10 });
    await mount();
    expect(f).toHaveBeenCalledWith("/api/aquarium/settings", expect.anything());
    await advance(9_999);
    expect(push).not.toHaveBeenCalled();
    await advance(1);
    expect(push).toHaveBeenCalledWith("/aquarium");
  });

  it("falls back to the default when the setting can't be read", async () => {
    serve({ error: "nope" }, 500);
    await mount();
    await advance(IDLE_SECONDS_DEFAULT * 1000 - 1);
    expect(push).not.toHaveBeenCalled();
    await advance(1);
    expect(push).toHaveBeenCalledWith("/aquarium");
  });

  it.each(["pointermove", "pointerdown", "keydown", "wheel", "scroll", "touchstart", "focusin"])(
    "starts the idle period over on %s",
    async (type) => {
      serve({ idle_seconds: 10 });
      await mount();
      await advance(8_000);
      act(() => {
        window.dispatchEvent(new Event(type));
      });
      await advance(8_000);
      expect(push).not.toHaveBeenCalled();
      await advance(2_000);
      expect(push).toHaveBeenCalledTimes(1);
    },
  );

  it("never fires while the composer has text", async () => {
    serve({ idle_seconds: 5 });
    const box = document.createElement("textarea");
    box.value = "half a thought";
    document.body.appendChild(box);
    await mount();
    await advance(60_000);
    expect(push).not.toHaveBeenCalled();
    box.value = "  ";
    await advance(5_000);
    expect(push).toHaveBeenCalledWith("/aquarium");
  });

  it("never fires while a turn is streaming (blocked)", async () => {
    serve({ idle_seconds: 5 });
    const view = await mount(true);
    await advance(60_000);
    expect(push).not.toHaveBeenCalled();
    view.rerender(<Harness blocked={false} />);
    await advance(5_000);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("never fires while a dialog or sheet is open", async () => {
    serve({ idle_seconds: 5 });
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    document.body.appendChild(sheet);
    await mount();
    await advance(60_000);
    expect(push).not.toHaveBeenCalled();
    sheet.remove();
    await advance(5_000);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("never fires while the page is hidden", async () => {
    serve({ idle_seconds: 5 });
    hidden = true;
    await mount();
    await advance(60_000);
    expect(push).not.toHaveBeenCalled();
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(4_999);
    expect(push).not.toHaveBeenCalled();
    await advance(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("is off away from the landing page", async () => {
    const f = serve({ idle_seconds: 5 });
    pathname = "/chat";
    await mount();
    await advance(60_000);
    expect(f).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("fetchIdleSeconds", () => {
  it("rejects out-of-range and non-integer values", async () => {
    for (const bad of [0, 4, 3601, 12.5, "30", null]) {
      serve({ idle_seconds: bad });
      expect(await fetchIdleSeconds()).toBe(IDLE_SECONDS_DEFAULT);
      vi.restoreAllMocks();
    }
    serve({ idle_seconds: 3600 });
    expect(await fetchIdleSeconds()).toBe(3600);
  });

  it("uses the default when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await fetchIdleSeconds()).toBe(IDLE_SECONDS_DEFAULT);
  });
});

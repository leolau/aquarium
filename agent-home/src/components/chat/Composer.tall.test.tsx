// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Composer } from "@/components/chat/Composer";

afterEach(cleanup);

function composer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  render(<Composer sending={false} storageEnabled sessionId="s1" onSend={() => {}} {...props} />);
  const root = document.querySelector<HTMLElement>('[data-component="Composer"]')!;
  return { root, textarea: root.querySelector("textarea")! };
}

describe("Composer tall (phone chat page)", () => {
  it("starts at three lines and caps at 40% of the visible height below lg", () => {
    const { textarea } = composer({ tall: true });
    expect(textarea.dataset.tall).toBe("true");
    expect(textarea.className).toContain("max-lg:min-h-[86px]");
    expect(textarea.className).toContain("max-lg:max-h-[calc(var(--vv-height,100dvh)*0.4)]");
    expect(textarea.className).toContain("max-lg:basis-full");
    // Desktop sizing stays as before.
    expect(textarea.className).toContain("min-h-[46px]");
    expect(textarea.className).toContain("max-h-48");
  });

  it("wraps the actions into one row under the input, idle and working", () => {
    for (const sending of [false, true]) {
      const { root } = composer({ tall: true, sending });
      const row = root.querySelector("textarea")!.parentElement!;
      expect(row.className).toContain("max-lg:flex-wrap");
      cleanup();
    }
  });

  it("reserves launcher space only on desktop with launcherClearance=desktop", () => {
    const { root } = composer({ tall: true, launcherClearance: "desktop", sending: true });
    expect(root.className).toContain("lg:ml-14");
    expect(root.className).not.toMatch(/(^|\s)ml-14/);
    expect(root.querySelector('[aria-label="Attach file"]')!.className).not.toContain("ml-14");
  });

  it("leaves the default composer unchanged", () => {
    const { root, textarea } = composer();
    expect(textarea.dataset.tall).toBeUndefined();
    expect(textarea.className).not.toContain("max-lg:");
    expect(root.className).toMatch(/(^|\s)ml-14/);
  });
});

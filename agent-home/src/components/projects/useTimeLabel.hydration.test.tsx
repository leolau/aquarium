// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agoLabel, dateTimeLabel } from "@/components/projects/format";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

const AT = Date.parse("2026-11-05T00:33:00Z") / 1000;

function Stamp() {
  const timeLabel = useTimeLabel();
  return (
    <p>
      {timeLabel(AT)} · {timeLabel(AT, "ago")} · {timeLabel(null, "ago")}
    </p>
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useTimeLabel", () => {
  it("renders only the UTC day on the server", () => {
    const html = renderToString(<Stamp />).replace(/<!-- -->/g, "");
    expect(html).toContain("2026-11-05 · 2026-11-05 · never");
  });

  it("hydrates without a mismatch when the clock moves, then shows local labels", async () => {
    vi.useFakeTimers({ now: AT * 1000 + 30_000, toFake: ["Date"] });
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Stamp />);
    document.body.appendChild(container);
    vi.setSystemTime(AT * 1000 + 2 * 3600_000);
    const errors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <Stamp />, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    expect(container.textContent).toBe(`${dateTimeLabel(AT)} · ${agoLabel(AT)} · never`);
    expect(agoLabel(AT)).toBe("2h ago");
  });
});

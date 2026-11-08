// @vitest-environment jsdom
/**
 * The pinned-cards section on ModelsView: lazy-fetches /api/models/pinned
 * after paint, renders one row per overriding card linking to its card
 * page, and stays hidden entirely when nothing is pinned.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelsView } from "@/components/models/ModelsView";
import type { ModelsOverviewResponse } from "@/types";

const OVERVIEW: ModelsOverviewResponse = {
  info: {
    model: "glm-5.2",
    provider: "alibaba",
    auto_context_length: 1_048_576,
    config_context_length: 0,
    effective_context_length: 1_048_576,
    capabilities: {},
  },
  auxiliary: {
    main: { provider: "alibaba", model: "glm-5.2" },
    tasks: [{ task: "vision", provider: "auto", model: "", base_url: "" }],
  },
  usage: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Empty performance payload — the Models page lazy-fetches it alongside
 * pinned; tests route by URL so each section gets its own body. */
const EMPTY_PERF = {
  period: { days: 7, months: 6 },
  models: [],
  monthly: [],
  collecting: true,
};

/** fetch stub that answers /api/models/pinned with `pinnedBody` and
 * /api/models/performance with an empty (still-collecting) read. */
function pinnedFetch(pinnedBody: unknown) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/models/performance")) {
      return Promise.resolve(jsonResponse(200, EMPTY_PERF));
    }
    return Promise.resolve(jsonResponse(200, pinnedBody));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelsView pinned cards", () => {
  it("shows pinned cards with model, status and a link to the card", async () => {
    const fetchMock = pinnedFetch({
      pinned: [
        {
          project_slug: "canva-deck",
          project_name: "Canva deck",
          task_id: "t_abc",
          title: "Generate slide 118",
          model: "deepseek-chat",
          status: "blocked",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { findByText, container } = render(<ModelsView initialAdvanced initial={OVERVIEW} />);
    await findByText("Generate slide 118");
    expect(container.textContent).toContain("Canva deck · blocked");
    expect(container.textContent).toContain("deepseek-chat");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/projects/canva-deck/cards/t_abc");
  });

  it("renders no section when nothing is pinned", async () => {
    const fetchMock = pinnedFetch({ pinned: [] });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ModelsView initialAdvanced initial={OVERVIEW} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).not.toContain("Pinned cards");
  });

  it("hides the section when the fetch fails — it is additive, not critical", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ModelsView initialAdvanced initial={OVERVIEW} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.textContent).not.toContain("Pinned cards"),
    );
  });
});

describe("ModelsView test button", () => {
  function testFetch(testBody: unknown) {
    return vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/models/test")) {
        return Promise.resolve(jsonResponse(200, testBody));
      }
      return Promise.resolve(jsonResponse(200, EMPTY_PERF));
    });
  }

  it("posts scope:main and shows the round-trip result", async () => {
    const fetchMock = testFetch({
      ok: true,
      model: "glm-5.2",
      latency_ms: 2100,
      reply: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, findByText } = render(<ModelsView initialAdvanced initial={OVERVIEW} />);
    fireEvent.click(await findByText("Test"));

    await waitFor(() =>
      expect(container.textContent).toContain("glm-5.2 replied in 2.1s"),
    );
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/models/test"),
    );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ scope: "main" });
  });

  it("surfaces a failed round-trip as an error, not a crash", async () => {
    const fetchMock = testFetch({
      ok: false,
      error: "401 Unauthorized — bad key",
      error_type: "AuthenticationError",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, findByText } = render(<ModelsView initialAdvanced initial={OVERVIEW} />);
    fireEvent.click(await findByText("Test"));

    await waitFor(() =>
      expect(container.textContent).toContain("401 Unauthorized — bad key"),
    );
  });
});

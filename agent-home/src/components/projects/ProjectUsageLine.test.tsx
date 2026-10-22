// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectUsageLine } from "./ProjectDetailView";

afterEach(cleanup);

describe("ProjectUsageLine", () => {
  it("shows the whole project's time and tokens, cache kept apart", () => {
    const { getByText } = render(
      <ProjectUsageLine
        usage={{
          runs: 2,
          run_seconds: 37_000,
          tokens: {
            calls: 630,
            input_tokens: 957_538,
            output_tokens: 489_955,
            cache_read_tokens: 57_316_224,
            reasoning_tokens: 0,
            total: 1_447_493,
          },
        }}
      />,
    );
    expect(getByText(/10h 16m over 2 runs/)).toBeTruthy();
    expect(
      getByText(
        "1.45M tokens (957.5K read, 490.0K written) + 57.32M re-read from cache",
      ),
    ).toBeTruthy();
  });

  it("says when nothing has run and when tokens weren't recorded", () => {
    const { getByText } = render(
      <ProjectUsageLine usage={{ runs: 0, run_seconds: 0, tokens: null }} />,
    );
    expect(getByText(/no runs yet/)).toBeTruthy();
    expect(getByText(/tokens not recorded/)).toBeTruthy();
  });
});

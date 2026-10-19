import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelsView } from "@/components/models/ModelsView";
import type { ModelsOverviewResponse } from "@/types";

function overview(overrides: Partial<ModelsOverviewResponse> = {}): ModelsOverviewResponse {
  return {
    info: {
      model: "glm-5.2",
      provider: "alibaba",
      auto_context_length: 1_048_576,
      config_context_length: 0,
      effective_context_length: 1_048_576,
      capabilities: {
        supports_tools: true,
        supports_vision: true,
        supports_reasoning: true,
      },
    },
    auxiliary: {
      main: { provider: "alibaba", model: "glm-5.2" },
      tasks: [
        { task: "vision", provider: "alibaba", model: "qwen3.8-max", base_url: "" },
        { task: "compression", provider: "auto", model: "", base_url: "" },
        { task: "web_extract", provider: "auto", model: "", base_url: "" },
        { task: "title_generation", provider: "auto", model: "", base_url: "" },
        { task: "approval", provider: "auto", model: "", base_url: "" },
      ],
    },
    usage: [
      {
        model: "glm-5.2",
        provider: "alibaba",
        sessions: 412,
        input_tokens: 8_000_000,
        output_tokens: 400_000,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost: 12.34,
        actual_cost: 0,
        last_used_at: null,
        capabilities: {},
      },
      {
        model: "deepseek-chat",
        provider: "deepseek",
        sessions: 4,
        input_tokens: 200_000,
        output_tokens: 10_000,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost: 0.05,
        actual_cost: 0,
        last_used_at: null,
        capabilities: {},
      },
    ],
    ...overrides,
  };
}

describe("ModelsView", () => {
  it("renders the main model with provider, context and capability pills", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    expect(html).toContain("Main model");
    expect(html).toContain("glm-5.2");
    expect(html).toContain("alibaba");
    expect(html).toContain("1M context");
    expect(html).toContain("tools");
    expect(html).toContain("reasoning");
    expect(html).toContain("Change");
  });

  it("shows pinned roles by model and auto roles as inheriting the main model", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    expect(html).toContain("Vision");
    expect(html).toContain("qwen3.8-max");
    expect(html).toContain("auto → glm-5.2");
  });

  it("shows the provider under each role's model", () => {
    const html = renderToStaticMarkup(
      <ModelsView
        initial={overview({
          auxiliary: {
            main: { provider: "deepseek", model: "deepseek-v4-flash" },
            tasks: [
              { task: "vision", provider: "opencode-go", model: "qwen3.8-max", base_url: "" },
              { task: "compression", provider: "auto", model: "", base_url: "" },
            ],
          },
        })}
      />,
    );
    expect(html).toMatch(/qwen3\.8-max<\/span><span[^>]*>opencode-go</);
    expect(html).toMatch(/auto → deepseek-v4-flash<\/span><span[^>]*>deepseek</);
  });

  it("shows the provider under each in-use model", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    expect(html).toMatch(/deepseek-chat<\/span>.*?>deepseek<\/span>/);
  });

  it("collapses non-top roles behind an expander", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    // 'approval' is not a top role — hidden behind the "+N more roles" row.
    expect(html).not.toContain(">Approval<");
    expect(html).toContain("more roles");
  });

  it("tags usage rows by the slot that serves them, or 'not configured'", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    expect(html).toContain("In use — last 30 days");
    expect(html).toContain("412 sessions");
    // glm-5.2 is the main model → 'main' tag; deepseek-chat serves nothing.
    expect(html).toContain(">main<");
    expect(html).toContain("not configured");
    expect(html).toContain("$12.34");
  });

  it("shows a quiet empty state when nothing has run", () => {
    const html = renderToStaticMarkup(
      <ModelsView initial={overview({ usage: [] })} />,
    );
    expect(html).toContain("No recorded usage");
  });

  it("warns that changes apply to new sessions only", () => {
    const html = renderToStaticMarkup(<ModelsView initial={overview()} />);
    expect(html).toContain("new sessions");
  });
});

"use client";

import { useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { toolLines } from "@/lib/chat/copy-chat";
import type { ChatToolEvent } from "@/lib/chat/stream";

export interface ToolChip extends ChatToolEvent {
  done: boolean;
}

const smallButton =
  "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:!min-h-0";

/**
 * Live "what is the agent doing" surface for a streaming turn: the model's
 * reasoning text as it arrives (so a long think never looks frozen) plus one
 * line per tool call. Muted on purpose — it is activity, not conversation.
 * "Maximize" opens the same steps and the full reasoning in a large panel.
 */
export function LiveActivity({
  reasoning,
  tools,
}: {
  reasoning: string;
  tools: ToolChip[];
}) {
  const [maximized, setMaximized] = useState(false);
  if (reasoning === "" && tools.length === 0) return null;
  const lines = toolLines(tools);
  return (
    <div data-component="LiveActivity" className="mt-2 space-y-1">
      <div className="flex justify-end">
        <button
          type="button"
          data-action="maximize-activity"
          aria-label="Maximize agent activity"
          title="Maximize"
          onClick={() => setMaximized(true)}
          className={smallButton}
        >
          ⤢ Maximize
        </button>
      </div>
      {tools.map((t, i) => (
        <div
          key={t.id || `${t.name}-${i}`}
          className="text-xs text-[var(--color-muted)]"
        >
          {lines[i]}
        </div>
      ))}
      {reasoning !== "" ? (
        <div
          data-component="LiveReasoning"
          className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs italic text-[var(--color-muted)]"
        >
          {reasoning}
        </div>
      ) : null}
      {maximized ? (
        <Sheet
          title="Agent activity"
          full
          component="LiveActivityMaximized"
          onClose={() => setMaximized(false)}
        >
          <div className="space-y-1 text-sm text-[var(--color-muted)]">
            {tools.map((t, i) => (
              <div key={t.id || `${t.name}-${i}`}>{lines[i]}</div>
            ))}
          </div>
          {reasoning !== "" ? (
            <div
              data-component="LiveReasoningFull"
              className="mt-3 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm italic text-[var(--color-muted)]"
            >
              {reasoning}
            </div>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}

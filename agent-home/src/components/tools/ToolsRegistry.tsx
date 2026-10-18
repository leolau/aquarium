import Link from "next/link";

import { Pill } from "@/components/ui/Pill";
import type { Tool, ToolKind, ToolsResponse } from "@/types";

/**
 * Home → Tools: the apps and helper services the agent has built or copied in
 * (the tool registry), read-only. The server already limits the list to what
 * the logged-in person may see: their own entries plus shared ones.
 */

const KIND_LABEL: Record<ToolKind, string> = {
  in_house: "Built by the agent",
  remote: "External service",
  builtin: "Comes with Aquarium",
};

function ToolRow({ tool }: { tool: Tool }) {
  const kind = KIND_LABEL[tool.kind] ?? tool.kind;
  const who = tool.visibility === "shared" ? "Shared with everyone" : "Private";
  return (
    <li data-component="ToolRow">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{tool.name}</span>
          <Pill tone={tool.enabled ? "success" : "muted"}>
            {tool.enabled ? "On" : "Off"}
          </Pill>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {kind} · {who}
        </p>
      </div>
    </li>
  );
}

function ToolList({ tools }: { tools: Tool[] }) {
  return (
    <ul data-component="ToolList" className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} />
      ))}
    </ul>
  );
}

function ToolsIntro() {
  return (
    <div data-component="ToolsIntro" className="flex flex-col gap-1">
      <h2 className="text-base font-semibold">
        Apps the agent has built or installed
      </h2>
      <p className="text-sm text-[var(--color-muted)]">
        Small apps and helper services the agent made or set up for you. You
        see your own and the ones shared with everyone.
      </p>
      <p className="text-sm text-[var(--color-muted)]">
        Looking for the tools the agent uses in chat (web search, browser,
        Canva…)? See{" "}
        <Link href="/settings/tools" className="text-[var(--color-accent)] underline">
          Settings → Tools &amp; Integrations
        </Link>
        .
      </p>
    </div>
  );
}

export function ToolsRegistry({ data }: { data: ToolsResponse }) {
  const enabled = data.tools.filter((t) => t.enabled);
  const disabled = data.tools.filter((t) => !t.enabled);

  let body;
  if (!data.configured) {
    body = (
      <p className="text-sm text-[var(--color-muted)]">
        This list isn&apos;t set up on this installation yet.
      </p>
    );
  } else if (data.tools.length === 0) {
    body = (
      <p className="text-sm text-[var(--color-muted)]">
        The agent hasn&apos;t built or installed any apps yet.
      </p>
    );
  } else {
    body = (
      <>
        {enabled.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No apps are turned on right now.
          </p>
        ) : (
          <ToolList tools={enabled} />
        )}
        {disabled.length > 0 ? (
          <details data-component="ToolsDisabled">
            <summary className="cursor-pointer text-sm text-[var(--color-muted)]">
              Turned off ({disabled.length})
            </summary>
            <div className="mt-2">
              <ToolList tools={disabled} />
            </div>
          </details>
        ) : null}
      </>
    );
  }

  return (
    <div data-component="ToolsRegistry" className="flex flex-col gap-4">
      <ToolsIntro />
      {body}
    </div>
  );
}

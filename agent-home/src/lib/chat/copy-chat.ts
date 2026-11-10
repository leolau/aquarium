/**
 * Plain-text export of a whole conversation for the "Copy chat" button:
 * every visible turn, each reply's saved reasoning, and the in-flight turn's
 * live activity (tool steps + reasoning) so nothing on screen is left out.
 */
import { splitCompactionContent, stripUiContextLine } from "@/lib/chat/transcript";
import type { ToolChip } from "@/components/chat/LiveActivity";
import type { ChatMessage } from "@/types";

export interface LiveTurnSnapshot {
  tools: ToolChip[];
  reasoning: string;
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");

export function toolLines(tools: ToolChip[]): string[] {
  return tools.map((t) => `${t.name} — ${t.done ? "done" : "running…"}`);
}

export function activityText({ tools, reasoning }: LiveTurnSnapshot): string {
  const parts: string[] = [];
  if (tools.length > 0) parts.push(toolLines(tools).map((l) => `- ${l}`).join("\n"));
  const r = reasoning.trim();
  if (r !== "") parts.push(`Reasoning:\n${quote(r)}`);
  return parts.join("\n\n");
}

export function chatTranscriptText(
  messages: ChatMessage[],
  live?: LiveTurnSnapshot | null,
  title?: string | null,
): string {
  const blocks: string[] = [];
  if (title?.trim()) blocks.push(`# ${title.trim()}`);
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const isUser = m.role === "user";
    const display = splitCompactionContent(m.content ?? "").display;
    const content = (isUser ? stripUiContextLine(display) : display).trim();
    const reasoning = isUser ? "" : (m.reasoning ?? "").trim();
    if (content === "" && reasoning === "") continue;
    const parts = [isUser ? "**You:**" : "**Agent:**"];
    if (reasoning !== "") parts.push(`Reasoning:\n${quote(reasoning)}`);
    if (content !== "") parts.push(content);
    blocks.push(parts.join("\n\n"));
  }
  if (live) {
    const act = activityText(live);
    if (act !== "") blocks.push(`**Agent activity (in progress):**\n\n${act}`);
  }
  return blocks.join("\n\n---\n\n") + "\n";
}

/** Copies `text`; false when the clipboard is unavailable or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

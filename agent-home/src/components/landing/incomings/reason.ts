import type { Translator } from "@/i18n/translate";
import type { IncomingItem } from "@/types";

type T = Translator;

/** The triage reason line under a row: "Escalated by triage · high priority". */
export function reasonLine(item: IncomingItem, t: T): string {
  switch (item.attention_reason) {
    case "escalated":
      return item.attention_priority
        ? t("reason.escalatedPriority", { priority: t(`priority.${item.attention_priority}`) })
        : t("reason.escalated");
    case "todo":
      return item.todo_count && item.todo_count > 1
        ? t("reason.todoCount", { count: item.todo_count })
        : t("reason.todo");
    case "critical_event":
      return t("reason.critical_event");
    default:
      return t("reason.flagged");
  }
}

/** A channel name that reads in the UI language, falling back to the raw id. */
export function surfaceName(surface: string, t: T): string {
  return t.has(`surface.${surface}`) ? t(`surface.${surface}`) : surface;
}

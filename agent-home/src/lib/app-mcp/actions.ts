/**
 * Command execution for app-mcp: the agent says what to do, the bridge does
 * it against the live DOM and reports what happened. Every command returns a
 * structured result — never throws — so the MCP tool always has something
 * sane to hand back to the agent.
 */
import { softNavigate } from "@/lib/app-mcp/navigation";
import { getUiContext, type UiContext } from "@/lib/app-mcp/state";
import {
  accessibleName,
  inShellChrome,
  isHidden,
  isSensitiveInput,
  snapshotElements,
} from "@/lib/app-mcp/snapshot";

/**
 * app-mcp resolves the target server-side from a fresh snapshot (so its
 * safety guard judges the element that will really be hit) and sends only
 * the snapshot id plus the name it checked. The page never re-resolves a
 * free-form name or CSS selector the agent typed.
 */
export interface ElementQuery {
  /** Stable id from a snapshot (`data-appmcp-id`). */
  elementId?: number;
  /** The accessible name app-mcp checked; a mismatch means the page changed. */
  expectName?: string;
}

export type AppMcpCommand =
  | { type: "snapshot" }
  | ({ type: "click" } & ElementQuery)
  | ({ type: "type"; value: string } & ElementQuery)
  | ({ type: "select"; value: string } & ElementQuery)
  | ({ type: "focus" } & ElementQuery)
  | ({ type: "read" } & ElementQuery)
  | ({ type: "scroll" } & ElementQuery)
  | { type: "navigate"; path: string };

export interface AppMcpActionResult {
  ok: boolean;
  detail: string;
  /** Fresh UI context after the action, when known. */
  state: UiContext | null;
  /** Snapshot entries — present for the `snapshot` command. */
  elements?: unknown;
}

function describe(el: Element): string {
  const name = accessibleName(el);
  const tag = el.tagName.toLowerCase();
  return name ? `${tag} "${name}"` : tag;
}

/** The live element for a snapshot id, or null (gone, hidden or shell chrome). */
export function resolveElement(query: ElementQuery): Element | null {
  if (typeof query.elementId !== "number" || !Number.isInteger(query.elementId)) return null;
  const el = document.querySelector(`[data-appmcp-id="${query.elementId}"]`);
  if (!el || isHidden(el) || inShellChrome(el)) return null;
  return el;
}

/**
 * Set an input's value through the NATIVE value setter so React's synthetic
 * onChange/input handlers fire — assigning `.value` directly is invisible to
 * controlled components.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fail(detail: string): AppMcpActionResult {
  return { ok: false, detail, state: getUiContext() };
}

function done(detail: string): AppMcpActionResult {
  return { ok: true, detail, state: getUiContext() };
}

export function executeCommand(cmd: AppMcpCommand): AppMcpActionResult {
  switch (cmd.type) {
    case "snapshot": {
      const elements = snapshotElements(document);
      return {
        ok: true,
        detail: `${elements.length} interactive elements`,
        state: getUiContext(),
        elements,
      };
    }
    case "navigate": {
      const path = cmd.path.trim();
      if (!path.startsWith("/") || path.startsWith("//")) {
        return fail(`Refusing to navigate to a non-internal path: ${path}`);
      }
      // Prefer the SPA router — a full reload severs the WebSockets this
      // command channel (and the folder bridge) runs on.
      if (!softNavigate(path)) window.location.assign(path);
      return done(`Navigated to ${path}`);
    }
    default:
      break;
  }

  const el = resolveElement(cmd);
  if (!el) return fail(`No element matched ${JSON.stringify(cmd)}`);
  if (typeof cmd.expectName === "string" && accessibleName(el) !== cmd.expectName) {
    return fail("The page changed since it was described. Call app_describe_page again.");
  }

  switch (cmd.type) {
    case "click": {
      (el as HTMLElement).click();
      return done(`Clicked ${describe(el)}`);
    }
    case "type": {
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
        return fail(`${describe(el)} is not a text input`);
      }
      setNativeValue(el as HTMLInputElement | HTMLTextAreaElement, cmd.value);
      return done(`Typed into ${describe(el)}`);
    }
    case "select": {
      if (el.tagName !== "SELECT") return fail(`${describe(el)} is not a select`);
      const select = el as HTMLSelectElement;
      select.value = cmd.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return done(`Selected "${cmd.value}" in ${describe(el)}`);
    }
    case "focus": {
      (el as HTMLElement).focus();
      return done(`Focused ${describe(el)}`);
    }
    case "read": {
      if (isSensitiveInput(el)) return fail("Refusing to read a password or secret field");
      const value =
        (el as HTMLInputElement).value ||
        el.getAttribute("aria-label") ||
        el.textContent ||
        "";
      return done(value.trim());
    }
    case "scroll": {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return done(`Scrolled ${describe(el)} into view`);
    }
    default:
      return fail(`Unknown command`);
  }
}

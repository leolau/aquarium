/**
 * Live DOM introspection for app-mcp.
 *
 * The agent asks "what is on this page?" and the answer is computed from the
 * real DOM at that moment — no hand-maintained registry to drift. Every
 * interactive element gets a stable `data-appmcp-id` (so a follow-up control
 * command can address it), a role, an accessible name, and a CSS selector as
 * a fallback locator. Deliberately jsdom-friendly: visibility is judged by
 * `hidden`/`aria-hidden` attributes rather than layout geometry, which jsdom
 * cannot compute.
 */

export interface AppMcpElement {
  id: number;
  role: string;
  name: string;
  tag: string;
  selector: string;
  value?: string;
  /** Password/secret field: its value is never included. */
  sensitive?: boolean;
  checked?: boolean;
  disabled?: boolean;
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
].join(",");

/**
 * The shell's floating chrome — the Coral launcher and the lead-chat panel.
 * app-mcp deliberately sees THROUGH it: when the user asks "which page are we
 * on?" they mean the page behind the panel they are chatting from, and the
 * composer they are typing in must not become the "last active element".
 */
export const SHELL_CHROME_SELECTOR =
  '[data-component="LeadChatHost"], [data-component="CoralHost"]';

/** True when `el` lives inside the shell's floating chrome. */
export function inShellChrome(el: Element): boolean {
  return Boolean(el.closest(SHELL_CHROME_SELECTOR));
}

let nextId = 1;

const SENSITIVE_HINT =
  /\b(pass(word|code|phrase)?|secret|token|api[ _-]?key|private[ _-]?key|pin|otp|one[ -]time[ _-]code|credentials?)s?\b/i;
const SENSITIVE_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-number|cc-csc)/i;

/**
 * True for inputs whose value must never reach the agent: password fields,
 * one-time codes, and anything labelled like a secret/token/API key.
 */
export function isSensitiveInput(el: Element): boolean {
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
  const input = el as HTMLInputElement;
  if (el.tagName === "INPUT" && input.type === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") ?? "")) return true;
  const label = input.labels && input.labels.length > 0 ? input.labels[0]?.textContent : "";
  const hints = [
    el.getAttribute("name"),
    el.id,
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
    label,
  ];
  return hints.some((h) => Boolean(h) && SENSITIVE_HINT.test(String(h).replace(/[_-]/g, " ")));
}

export function isHidden(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.hidden || html.getAttribute("aria-hidden") === "true") return true;
  if ((el as HTMLInputElement).type === "hidden") return true;
  return Boolean(el.closest("[hidden], [aria-hidden='true']"));
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    switch ((el as HTMLInputElement).type) {
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "submit":
      case "button":
      case "reset":
        return "button";
      case "range":
        return "slider";
      default:
        return "textbox";
    }
  }
  return "element";
}

/**
 * The accessible name, best-effort: aria-label, associated <label>, then
 * visible text / placeholder / title / alt / value. Flat single line, capped,
 * because this text ends up in agent context.
 */
export function accessibleName(el: Element): string {
  const html = el as HTMLElement;
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  const labelled = el as HTMLInputElement;
  const label = labelled.labels && labelled.labels.length > 0
    ? labelled.labels[0]?.textContent
    : undefined;
  if (label && label.trim()) return label.trim();
  const text = html.textContent;
  if (text && text.trim()) return text.trim();
  const attr =
    el.getAttribute("placeholder") ??
    el.getAttribute("title") ??
    el.getAttribute("alt") ??
    (isSensitiveInput(el) ? "" : (el as HTMLInputElement).value) ??
    "";
  return attr.trim();
}

/** `CSS.escape` with a conservative fallback (jsdom has no CSS global). */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** A short, robust-ish CSS locator used when the id attribute is gone. */
export function selectorFor(el: Element): string {
  const html = el as HTMLElement;
  if (html.id) return `#${cssEscape(html.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 4; depth += 1) {
    const current: Element = node;
    const parent: Element | null = current.parentElement;
    const tag = current.tagName.toLowerCase();
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === current.tagName,
    );
    const nth =
      siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
    parts.unshift(`${tag}${nth}`);
    if ((parent as HTMLElement).id) {
      parts.unshift(`#${cssEscape((parent as HTMLElement).id)}`);
      break;
    }
    node = parent;
  }
  return parts.join(" > ");
}

/** A compact reference for awareness tracking (no id/selector needed). */
export function elementRef(el: Element): { role: string; name: string } {
  return { role: roleOf(el), name: accessibleName(el) };
}

/**
 * Snapshot every interactive element under `root`. Ids are assigned once per
 * element (they survive re-snapshots while the element lives), so a control
 * command issued right after a describe still resolves.
 */
export function snapshotElements(root: ParentNode = document): AppMcpElement[] {
  const out: AppMcpElement[] = [];
  for (const el of Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (isHidden(el) || inShellChrome(el)) continue;
    const html = el as HTMLElement;
    if (!html.dataset.appmcpId) html.dataset.appmcpId = String(nextId++);
    const entry: AppMcpElement = {
      id: Number(html.dataset.appmcpId),
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
    };
    const input = el as HTMLInputElement;
    if (isSensitiveInput(el)) {
      entry.sensitive = true;
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      entry.value = input.value;
    }
    if (el.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) {
      entry.checked = input.checked;
    }
    if (input.disabled) entry.disabled = true;
    out.push(entry);
  }
  return out;
}

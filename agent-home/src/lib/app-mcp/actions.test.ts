// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCommand, resolveElement } from "@/lib/app-mcp/actions";
import { registerSoftNavigate } from "@/lib/app-mcp/navigation";
import { setUiContext } from "@/lib/app-mcp/state";
import { snapshotElements } from "@/lib/app-mcp/snapshot";

beforeEach(() => {
  document.body.innerHTML = "";
  setUiContext({ path: "/todos", element: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Snapshot id of the element with this accessible name (what app-mcp sends). */
function idOf(name: string): number {
  const entry = snapshotElements(document).find((e) => e.name === name);
  if (!entry) throw new Error(`no element named ${name}`);
  return entry.id;
}

describe("executeCommand snapshot", () => {
  it("returns the interactive elements with fresh ids", () => {
    document.body.innerHTML = `<button>Filter</button><a href="/chat">Chats</a>`;
    const res = executeCommand({ type: "snapshot" });
    expect(res.ok).toBe(true);
    const elements = res.elements as Array<{ name: string }>;
    expect(elements.map((e) => e.name).sort()).toEqual(["Chats", "Filter"]);
    expect(res.state?.path).toBe("/todos");
  });
});

describe("executeCommand click", () => {
  it("clicks by snapshot id and reports the element", () => {
    document.body.innerHTML = `<button type="button">Filter</button>`;
    const [entry] = snapshotElements(document);
    const onClick = vi.fn();
    document.querySelector("button")!.addEventListener("click", onClick);

    const res = executeCommand({ type: "click", elementId: entry.id });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('"Filter"');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("never re-resolves a free-form name or CSS selector (F4)", () => {
    document.body.innerHTML = `<button type="button">Archive</button><button id="del">Delete all</button>`;
    const onDelete = vi.fn();
    document.querySelector("#del")!.addEventListener("click", onDelete);

    const byName = executeCommand({ type: "click", name: "archive" } as never);
    const bySelector = executeCommand({ type: "click", selector: "#del" } as never);
    expect(byName.ok).toBe(false);
    expect(bySelector.ok).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("refuses when the element under the id no longer has the name app-mcp checked (F4)", () => {
    document.body.innerHTML = `<button type="button">Rename</button>`;
    const id = idOf("Rename");
    const button = document.querySelector("button")!;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    button.textContent = "Delete forever";

    const res = executeCommand({ type: "click", elementId: id, expectName: "Rename" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("page changed");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("refuses hidden elements even by id", () => {
    document.body.innerHTML = `<button type="button">Later hidden</button>`;
    const id = idOf("Later hidden");
    document.querySelector("button")!.setAttribute("hidden", "");
    const res = executeCommand({ type: "click", elementId: id });
    expect(res.ok).toBe(false);
  });

  it("fails cleanly when nothing matches", () => {
    document.body.innerHTML = `<button>Only</button>`;
    const res = executeCommand({ type: "click", elementId: 999999 });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("No element matched");
  });
});

describe("executeCommand type", () => {
  it("sets the value through the native setter and fires input", () => {
    document.body.innerHTML = `<input type="text" aria-label="Title" />`;
    const input = document.querySelector("input")!;
    const onInput = vi.fn();
    input.addEventListener("input", onInput);

    const res = executeCommand({ type: "type", elementId: idOf("Title"), value: "Ship it" });
    expect(res.ok).toBe(true);
    expect(input.value).toBe("Ship it");
    expect(onInput).toHaveBeenCalled();
  });

  it("refuses non-text targets", () => {
    document.body.innerHTML = `<button>Send</button>`;
    const res = executeCommand({ type: "type", elementId: idOf("Send"), value: "x" });
    expect(res.ok).toBe(false);
  });
});

describe("executeCommand select/read/focus", () => {
  it("selects an option and fires change", () => {
    document.body.innerHTML = `
      <select aria-label="Stage">
        <option value="open">Open</option>
        <option value="done">Done</option>
      </select>`;
    const select = document.querySelector("select")!;
    const onChange = vi.fn();
    select.addEventListener("change", onChange);

    const res = executeCommand({ type: "select", elementId: idOf("Stage"), value: "done" });
    expect(res.ok).toBe(true);
    expect(select.value).toBe("done");
    expect(onChange).toHaveBeenCalled();
  });

  it("reads the current value of an input", () => {
    document.body.innerHTML = `<input type="text" aria-label="Query" value="hello" />`;
    const res = executeCommand({ type: "read", elementId: idOf("Query") });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe("hello");
  });

  it("focuses an element", () => {
    document.body.innerHTML = `<button>Target</button>`;
    const res = executeCommand({ type: "focus", elementId: idOf("Target") });
    expect(res.ok).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("button"));
  });
});

describe("executeCommand navigate", () => {
  afterEach(() => registerSoftNavigate(null));

  it("refuses external or protocol-relative paths", () => {
    const res = executeCommand({ type: "navigate", path: "https://evil.example" });
    expect(res.ok).toBe(false);
    const res2 = executeCommand({ type: "navigate", path: "//evil.example" });
    expect(res2.ok).toBe(false);
  });

  it("assigns internal paths to the window location", () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, pathname: "/todos", protocol: "http:", host: "localhost" },
      configurable: true,
    });
    const res = executeCommand({ type: "navigate", path: "/chat" });
    expect(res.ok).toBe(true);
    expect(assign).toHaveBeenCalledWith("/chat");
  });

  it("prefers the registered soft navigator — a full reload would sever the bridge WebSockets", () => {
    const soft = vi.fn();
    const assign = vi.fn();
    registerSoftNavigate(soft);
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign, pathname: "/todos", protocol: "http:", host: "localhost" },
      configurable: true,
    });
    const res = executeCommand({ type: "navigate", path: "/files" });
    expect(res.ok).toBe(true);
    expect(soft).toHaveBeenCalledWith("/files");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("resolveElement", () => {
  it("resolves only by snapshot id", () => {
    document.body.innerHTML = `<button id="a">One</button><button>Two</button>`;
    const snap = snapshotElements(document);
    const two = snap.find((e) => e.name === "Two")!;
    expect(resolveElement({ elementId: two.id })?.textContent).toBe("Two");
    expect(resolveElement({})).toBeNull();
  });
});

describe("sensitive fields (F4)", () => {
  it("snapshots never include password or secret values", () => {
    document.body.innerHTML = `
      <input type="password" aria-label="Current" value="hunter2" />
      <input type="password" value="nolabel-secret" />
      <input type="text" name="api_key" value="sk-live-123" />
      <label>Access token <input type="text" value="tok-abc" /></label>
      <input type="text" autocomplete="one-time-code" value="424242" />
      <input type="text" aria-label="Title" value="Ship it" />`;
    const snap = snapshotElements(document);
    const dump = JSON.stringify(snap);
    for (const secret of ["hunter2", "nolabel-secret", "sk-live-123", "tok-abc", "424242"]) {
      expect(dump).not.toContain(secret);
    }
    expect(snap.filter((e) => e.sensitive)).toHaveLength(5);
    expect(snap.find((e) => e.name === "Title")?.value).toBe("Ship it");
  });

  it("read refuses a password field", () => {
    document.body.innerHTML = `<input type="password" aria-label="Password" value="hunter2" />`;
    const res = executeCommand({ type: "read", elementId: idOf("Password") });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain("hunter2");
  });
});

describe("user-only controls (F17/F18)", () => {
  it("snapshot flags controls inside a data-appmcp-deny region", () => {
    document.body.innerHTML = `
      <div data-appmcp-deny="consent"><button>Approve</button></div>
      <label data-appmcp-deny="consent"><input type="checkbox" /> Trusted for import</label>
      <button>Filter</button>`;
    const snap = snapshotElements(document);
    expect(snap.find((e) => e.name === "Approve")?.denied).toBe(true);
    expect(snap.find((e) => e.name === "Trusted for import")?.denied).toBe(true);
    expect(snap.find((e) => e.name === "Filter")?.denied).toBeUndefined();
  });

  it("refuses to click an approval button or toggle folder trust", () => {
    document.body.innerHTML = `
      <div data-appmcp-deny="consent"><button>Always approve</button></div>
      <label data-appmcp-deny="consent"><input type="checkbox" /> Trusted for import</label>`;
    const onApprove = vi.fn();
    document.querySelector("button")!.addEventListener("click", onApprove);
    const trust = document.querySelector("input")!;

    const a = executeCommand({ type: "click", elementId: idOf("Always approve") });
    const t = executeCommand({ type: "click", elementId: idOf("Trusted for import") });
    const f = executeCommand({ type: "focus", elementId: idOf("Trusted for import") });
    expect([a.ok, t.ok, f.ok]).toEqual([false, false, false]);
    expect(a.detail).toContain("user-only");
    expect(onApprove).not.toHaveBeenCalled();
    expect(trust.checked).toBe(false);
  });

  it("still allows reading a user-only control", () => {
    document.body.innerHTML = `<div data-appmcp-deny="consent"><button>Deny</button></div>`;
    const res = executeCommand({ type: "read", elementId: idOf("Deny") });
    expect(res.ok).toBe(true);
  });
});

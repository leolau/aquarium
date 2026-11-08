// @vitest-environment jsdom
/**
 * The secrets form (FG-33 P8-2 2.7): a value typed here reaches the BFF once
 * and nowhere else — app-mcp's page snapshot never carries it, app-mcp cannot
 * fill or press anything in the form, and after saving the field is empty.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/tools/weather-board",
  useSearchParams: () => new URLSearchParams(),
}));

import { AppSecretsForm } from "@/components/apps-secrets/AppSecretsForm";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import { executeCommand } from "@/lib/app-mcp/actions";
import { snapshotElements } from "@/lib/app-mcp/snapshot";

const VALUE = "sk_live_51HxSUPERsecretVALUE";
const PATH = "/api/tools/apps/weather-board/secrets";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(names: string[], restart = false, status = 200, detail?: string) {
  return new Response(
    JSON.stringify(status === 200 ? { mode: "dev", secret_names: names, restart_needed: restart } : { detail }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function mount(names: string[] = ["APP_MCP_TOKEN", "OLD_KEY"], canEdit = true) {
  const view = render(
    <AppSecretsForm name="weather-board" mode="dev" secretNames={names} canEdit={canEdit} />,
  );
  fireEvent.click(view.getByRole("button", { name: "Manage secrets" }));
  const nameInput = view.getByLabelText("Name") as HTMLInputElement;
  const valueInput = view.getByLabelText("Value") as HTMLInputElement;
  const save = view.getByRole("button", { name: "Save secret" });
  return { view, nameInput, valueInput, save };
}

function fill(nameInput: HTMLInputElement, valueInput: HTMLInputElement, name: string, value: string) {
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(valueInput, { target: { value } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => answer(["APP_MCP_TOKEN", "OLD_KEY", "STRIPE_KEY"], true));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AppSecretsForm", () => {
  it("lists names only; the managed MCP bearer has no Remove", () => {
    const { view } = mount();
    const list = view.getByRole("list", { name: "Secret names" });
    expect(within(list).getByText("OLD_KEY")).toBeTruthy();
    expect(within(list).getByText("Set by Aquarium")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Remove APP_MCP_TOKEN" })).toBeNull();
    expect(view.getByRole("button", { name: "Remove OLD_KEY" })).toBeTruthy();
  });

  it("keeps the typed value out of every app-mcp snapshot and refuses app-mcp acts", () => {
    const { nameInput, valueInput, save } = mount();
    fill(nameInput, valueInput, "STRIPE_KEY", VALUE);
    expect(valueInput.type).toBe("password");
    const elements = snapshotElements(document);
    expect(JSON.stringify(elements)).not.toContain(VALUE);
    const valueEntry = elements.find((e) => e.name === "Value");
    expect(valueEntry?.sensitive).toBe(true);
    expect(save.closest("[data-appmcp-deny]")).toBe(save);
    for (const e of elements) expect(e.denied).toBe(true);

    const idOf = (name: string) => elements.find((e) => e.name === name)?.id;
    expect(executeCommand({ type: "read", elementId: idOf("Value") }).ok).toBe(false);
    expect(executeCommand({ type: "type", elementId: idOf("Value"), value: "x" }).ok).toBe(false);
    expect(executeCommand({ type: "type", elementId: idOf("Name"), value: "X" }).ok).toBe(false);
    expect(executeCommand({ type: "click", elementId: idOf("Save secret") }).ok).toBe(false);
    expect(executeCommand({ type: "click", elementId: idOf("Remove OLD_KEY") }).ok).toBe(false);
    expect(valueInput.value).toBe(VALUE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves once with an Idempotency-Key, clears the value and shows the new names", async () => {
    const { view, nameInput, valueInput, save } = mount();
    fill(nameInput, valueInput, "stripe_key", VALUE);
    expect(nameInput.value).toBe("STRIPE_KEY");
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(valueInput.value).toBe(""));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(PATH);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({ mode: "dev", name: "STRIPE_KEY", value: VALUE });
    expect(nameInput.value).toBe("");
    expect(await view.findByText("STRIPE_KEY")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Restart the app");
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("refuses a reserved name or an empty value without sending anything", () => {
    const { view, nameInput, valueInput, save } = mount();
    fill(nameInput, valueInput, "DATABASE_URL", VALUE);
    fireEvent.click(save);
    expect(view.getByRole("alert").textContent).toContain("reserved");
    fill(nameInput, valueInput, "STRIPE_KEY", "");
    fireEvent.click(save);
    expect(view.getByRole("alert").textContent).toContain("Enter a value");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a refusal and keeps the value so the person can retry", async () => {
    fetchMock.mockResolvedValueOnce(answer([], false, 409, "at most 50 secrets per app and mode"));
    const { view, nameInput, valueInput, save } = mount();
    fill(nameInput, valueInput, "STRIPE_KEY", VALUE);
    await act(async () => {
      fireEvent.click(save);
    });
    expect((await view.findByRole("alert")).textContent).toContain("at most 50 secrets");
    expect(valueInput.value).toBe(VALUE);
  });

  it("removes a secret only after the one explicit confirmation", async () => {
    fetchMock.mockResolvedValue(answer(["APP_MCP_TOKEN"]));
    const { view } = mount();
    fireEvent.click(view.getByRole("button", { name: "Remove OLD_KEY" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = view.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Remove" });
    expect(confirm.closest("[data-appmcp-deny]")).toBeTruthy();
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(PATH);
    expect(JSON.parse(String(init.body))).toEqual({ mode: "dev", name: "OLD_KEY", delete: true });
    expect(view.queryByText("OLD_KEY")).toBeNull();
  });

  it("shows each secret masked with when it was set, and hides editing until Manage", () => {
    vi.useFakeTimers({ now: new Date("2026-11-08T12:00:00Z") });
    try {
      const view = render(
        <AppSecretsForm
          name="weather-board"
          mode="dev"
          secretNames={["GMAIL_TOKEN", "OLD_KEY"]}
          secrets={[{ name: "GMAIL_TOKEN", updated_at: "2026-11-05T11:00:00Z" }]}
        />,
      );
      const gmail = view.container.querySelector('[data-secret="GMAIL_TOKEN"]');
      expect(gmail?.textContent).toContain("••••••••");
      expect(gmail?.textContent).toContain("set 3 days ago");
      const old = view.container.querySelector('[data-secret="OLD_KEY"]');
      expect(old?.textContent).toContain("••••••••");
      expect(old?.textContent).not.toContain("set ");
      expect(view.getByText("Owner only")).toBeTruthy();
      expect(view.queryByLabelText("Value")).toBeNull();
      expect(view.queryByRole("button", { name: "Remove OLD_KEY" })).toBeNull();
      const manage = view.getByRole("button", { name: "Manage secrets" });
      expect(manage.closest("[data-appmcp-deny]")).toBeTruthy();
      fireEvent.click(manage);
      expect(view.getByLabelText("Value")).toBeTruthy();
      expect(view.getByRole("button", { name: "Done" }).getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates the set time from the answer after saving", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "dev",
          secret_names: ["OLD_KEY"],
          secrets: [{ name: "OLD_KEY", updated_at: new Date().toISOString() }],
          restart_needed: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { view, nameInput, valueInput, save } = mount(["OLD_KEY"]);
    expect(view.container.querySelector('[data-secret="OLD_KEY"]')?.textContent).not.toContain("set ");
    fill(nameInput, valueInput, "OLD_KEY", VALUE);
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(view.container.querySelector('[data-secret="OLD_KEY"]')?.textContent).toContain("set now"),
    );
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("locks the confirm on its first press so a remove is sent once", async () => {
    let finish: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    const { view } = mount();
    fireEvent.click(view.getByRole("button", { name: "Remove OLD_KEY" }));
    const confirm = within(view.getByRole("dialog")).getByRole("button", { name: "Remove" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => finish(answer(["APP_MCP_TOKEN"])));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is read-only when the person may not edit", () => {
    const view = render(
      <AppSecretsForm name="weather-board" mode="dev" secretNames={["OLD_KEY"]} canEdit={false} />,
    );
    expect(view.queryByLabelText("Value")).toBeNull();
    expect(view.queryByRole("button", { name: "Remove OLD_KEY" })).toBeNull();
    expect(view.queryByRole("button", { name: "Manage secrets" })).toBeNull();
    expect(view.getByText("OLD_KEY")).toBeTruthy();
  });
});

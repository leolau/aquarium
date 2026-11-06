// @vitest-environment jsdom
/**
 * FG-28 C4: bulk import targets one of the caller's administered profiles; the
 * query and body name the same one, and a preview never carries over to
 * another profile's apply.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CsvImportPanel } from "@/components/users/CsvImportPanel";

let fetchMock: ReturnType<typeof vi.fn>;
const posts = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    query: new URL(String(url), "http://x").searchParams.get("profile"),
    body: JSON.parse(String((init as RequestInit).body)),
  }));

beforeEach(() => {
  fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return Response.json({
      ok: true,
      dry_run: body.dry_run,
      total: 1,
      failed: 0,
      rows: [
        {
          line: 1,
          email: "a@x.io",
          display: "A",
          role: "member",
          planned: "create",
          user_id: "",
          error: "",
          activation_path: body.dry_run ? null : `/activate/${body.profile}/tok`,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CsvImportPanel — target profile (FG-28 C4)", () => {
  it("shows no picker for one administered profile", () => {
    render(<CsvImportPanel profile="hr" profiles={["hr"]} />);
    expect(screen.queryByLabelText("Import into profile")).toBeNull();
  });

  it("previews and applies into the picked profile, query and body agreeing", async () => {
    const onApplied = vi.fn();
    render(<CsvImportPanel profile="hr" profiles={["default", "hr"]} onApplied={onApplied} />);
    const picker = screen.getByLabelText("Import into profile") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["default", "hr"]);
    expect(picker.value).toBe("hr");

    fireEvent.change(picker, { target: { value: "default" } });
    fireEvent.change(screen.getByLabelText("CSV rows"), { target: { value: "a@x.io,A,member" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/Preview: 1 row/);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/Applied: 1 row/);

    expect(posts()).toEqual([
      { query: "default", body: { csv: "a@x.io,A,member", profile: "default", dry_run: true } },
      { query: "default", body: { csv: "a@x.io,A,member", profile: "default", dry_run: false } },
    ]);
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("default", expect.anything()));
    // The server's link is shown as returned (made absolute for copying only).
    expect(document.body.textContent).toContain("/activate/default/tok");
  });

  it("drops the preview when the target changes, so Apply needs a fresh one", async () => {
    render(<CsvImportPanel profile="hr" profiles={["default", "hr"]} />);
    fireEvent.change(screen.getByLabelText("CSV rows"), { target: { value: "a@x.io,A,member" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText(/Preview: 1 row/);
    fireEvent.change(screen.getByLabelText("Import into profile"), { target: { value: "default" } });
    expect(screen.queryByText(/Preview: 1 row/)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  });
});

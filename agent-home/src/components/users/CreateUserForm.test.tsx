// @vitest-environment jsdom
/**
 * FG-28 C4: the create form targets one of the caller's administered profiles,
 * starting on the one being viewed, and offers nothing else.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateUserForm } from "@/components/users/CreateUserForm";

afterEach(cleanup);

function form(profiles: string[], profile = "hr") {
  const onCreate = vi.fn(async () => {});
  render(<CreateUserForm profile={profile} profiles={profiles} busy={false} disabled={false} onCreate={onCreate} />);
  return onCreate;
}

describe("CreateUserForm — target profile (FG-28 C4)", () => {
  it("shows no picker for one administered profile and creates there", async () => {
    const onCreate = form(["hr"]);
    expect(screen.queryByLabelText("Profile")).toBeNull();
    expect(document.body.textContent).toContain("Creating in hr");
    expect(document.body.textContent).not.toMatch(/FG-28|profile only/);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "n@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ profile: "hr" })));
  });

  it("offers exactly the administered profiles, defaulting to the viewed one", async () => {
    const onCreate = form(["default", "hr", "engineers"]);
    const picker = screen.getByLabelText("Profile") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["default", "hr", "engineers"]);
    expect(picker.value).toBe("hr");

    fireEvent.change(picker, { target: { value: "engineers" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "n@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ email: "n@x.io", profile: "engineers" })),
    );
  });

  it("submits once for a double submit while the create is in flight", async () => {
    let finish = () => {};
    const onCreate = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<CreateUserForm profile="hr" profiles={["default", "hr"]} busy={false} disabled={false} onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "n@x.io" } });
    const button = screen.getByRole("button", { name: "Create user" });
    fireEvent.click(button);
    fireEvent.click(button);
    finish();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });
});

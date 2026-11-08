// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let path = "/projects/tender/cards/c1";
vi.mock("next/navigation", () => ({ usePathname: () => path }));

import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader", () => {
  it("links Back to the logical parent and shows the trail", () => {
    render(<PageHeader title="Card" labels={{ "/projects/tender": "Tender bids" }} />);
    const back = document.querySelector('[data-action="back"]') as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/projects/tender");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Card");
    const crumbs = [...document.querySelectorAll("ol a")].map((a) => a.getAttribute("href"));
    expect(crumbs).toEqual(["/", "/projects", "/projects/tender"]);
    expect(screen.getAllByText("Tender bids").length).toBeGreaterThan(0);
  });

  it("honours an explicit back override", () => {
    path = "/skills/foo/edit";
    render(<PageHeader title="Edit" back={{ href: "/skills/foo", label: "Foo skill" }} />);
    const back = document.querySelector('[data-action="back"]') as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/skills/foo");
  });

  it("has no Back row on Home", () => {
    path = "/";
    render(<PageHeader title="Home" />);
    expect(document.querySelector('[data-action="back"]')).toBeNull();
  });
});

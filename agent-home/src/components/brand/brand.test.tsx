import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AquariumLoader } from "./AquariumLoader";
import { AquariumMark } from "./AquariumMark";

describe("brand", () => {
  it("uses the favicon art at small sizes and the full icon above 24px", () => {
    const { rerender } = render(<AquariumMark size={16} />);
    expect(screen.getByAltText("Aquarium").getAttribute("src")).toBe("/brand/aquarium-favicon.svg");
    rerender(<AquariumMark size={64} />);
    expect(screen.getByAltText("Aquarium").getAttribute("src")).toBe("/brand/aquarium-icon.svg");
  });

  it("announces the loader as a status", () => {
    render(<AquariumLoader label="Starting chat…" />);
    expect(screen.getByRole("status").textContent).toContain("Starting chat…");
  });
});

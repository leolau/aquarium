import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CREATURES, CREATURE_IDS } from "@/lib/aquarium/creatures";

import { CreatureIcon } from "./CreatureIcon";
import { CREATURE_ART } from "./creatures";

describe("creature drawings", () => {
  it("has exactly one drawing per creature id", () => {
    expect(Object.keys(CREATURE_ART).sort()).toEqual([...CREATURE_IDS].sort());
  });

  it("gives every drawing visible, distinct, colourful artwork", () => {
    const signatures = new Set<string>();
    for (const id of CREATURE_IDS) {
      const parts = CREATURE_ART[id].parts;
      expect(parts.length).toBeGreaterThanOrEqual(4);
      for (const p of parts) {
        expect(p.d).toMatch(/^M/);
        expect(p.fill || p.stroke).toBeTruthy();
      }
      expect(new Set(parts.map((p) => p.fill).filter(Boolean)).size).toBeGreaterThanOrEqual(2);
      signatures.add(parts.map((p) => p.d).join("|"));
    }
    expect(signatures.size).toBe(CREATURE_IDS.length);
  });
});

describe("CreatureIcon", () => {
  it("renders a labelled SVG for every creature", () => {
    for (const c of CREATURES) {
      const html = renderToStaticMarkup(<CreatureIcon id={c.id} size={40} />);
      expect(html).toContain(`data-creature="${c.id}"`);
      expect(html).toContain(`aria-label="${c.label}"`);
      expect(html).toContain('width="40"');
      expect(html).toContain("<path");
    }
  });

  it("is hidden from assistive tech when decorative", () => {
    const html = renderToStaticMarkup(<CreatureIcon id="crab" label="" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=");
  });
});

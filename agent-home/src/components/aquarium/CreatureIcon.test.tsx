import { existsSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CREATURES, CREATURE_IDS, creatureSprite } from "@/lib/aquarium/creatures";

import { CreatureIcon } from "./CreatureIcon";
import { CREATURE_ART } from "./creatures";

const V1_IDS = CREATURE_IDS.slice(0, 20);

describe("creature drawings", () => {
  it("has a drawing for each of the original 20 creature ids", () => {
    expect(Object.keys(CREATURE_ART).sort()).toEqual([...V1_IDS].sort());
  });

  it("gives every drawing visible, distinct, colourful artwork", () => {
    const signatures = new Set<string>();
    for (const id of V1_IDS) {
      const parts = CREATURE_ART[id]!.parts;
      expect(parts.length).toBeGreaterThanOrEqual(4);
      for (const p of parts) {
        expect(p.d).toMatch(/^M/);
        expect(p.fill || p.stroke).toBeTruthy();
      }
      expect(new Set(parts.map((p) => p.fill).filter(Boolean)).size).toBeGreaterThanOrEqual(2);
      signatures.add(parts.map((p) => p.d).join("|"));
    }
    expect(signatures.size).toBe(V1_IDS.length);
  });
});

describe("CreatureIcon", () => {
  it("renders the labelled sprite for every creature", () => {
    for (const c of CREATURES) {
      const html = renderToStaticMarkup(<CreatureIcon id={c.id} size={40} label={c.label} />);
      expect(html).toContain(`src="${creatureSprite(c.id)}"`);
      expect(html).toContain(`data-creature="${c.id}"`);
      expect(html).toContain(`alt="${c.label}"`);
      expect(html).toContain('width="40"');
      expect(html).not.toContain("aria-hidden");
    }
  });

  it("is decorative unless given a label", () => {
    for (const html of [
      renderToStaticMarkup(<CreatureIcon id="crab" />),
      renderToStaticMarkup(<CreatureIcon id="crab" label="" />),
    ]) {
      expect(html).toContain('alt=""');
      expect(html).toContain('aria-hidden="true"');
    }
  });

  it("renders nothing for an unknown id", () => {
    expect(renderToStaticMarkup(<CreatureIcon id={"kraken" as never} />)).toBe("");
  });
});

describe("creature sprites", () => {
  it("ships a sprite file for every creature", () => {
    for (const id of CREATURE_IDS) {
      expect(existsSync(join(process.cwd(), "public", creatureSprite(id))), id).toBe(true);
    }
  });
});

import type { CreatureId } from "@/lib/aquarium/creatures";

import { circle, ellipse, eye, star, type CreatureArt, type CreaturePart } from "./shapes";

export { VIEWBOX, type CreatureArt, type CreaturePart } from "./shapes";

const INK = "#14171f";

function tentacles(): CreaturePart[] {
  const out: CreaturePart[] = [];
  for (let i = 0; i < 6; i++) {
    const x0 = 34 + i * 6.4;
    const end = 12 + i * 15.2;
    const mid = (x0 + end) / 2;
    out.push({
      d: `M${x0 - 3.5} 54Q${mid - 7} 74 ${end} 90Q${mid + 3} 76 ${x0 + 3.5} 54Z`,
      fill: "#ff6a6a",
      stroke: "#c2353d",
      width: 1.2,
    });
  }
  return out;
}

function jellyTentacles(): CreaturePart[] {
  return [30, 40, 60, 70].map((x, i) => ({
    d: `M${x} 50Q${x - 5} ${62 + i} ${x + 1} 74Q${x + 6} 84 ${x - 1} 96`,
    stroke: "#f0c8ff",
    width: 2.2,
  }));
}

export const CREATURE_ART: Record<CreatureId, CreatureArt> = {
  clownfish: {
    parts: [
      { d: "M24 50L6 34Q3 50 6 66Z", fill: "#ff7a1a", stroke: INK, width: 2 },
      { d: "M42 34Q50 16 66 32Z", fill: "#ff7a1a", stroke: INK, width: 2 },
      { d: "M46 66Q52 80 62 68Z", fill: "#ff7a1a", stroke: INK, width: 2 },
      { d: "M22 50C22 36 40 30 55 30C74 30 90 40 90 50C90 60 74 70 55 70C40 70 22 64 22 50Z", fill: "#ff7a1a", stroke: INK, width: 2 },
      { d: "M70 32Q77 50 70 68L63 69Q70 50 63 31Z", fill: "#ffffff", stroke: INK, width: 1.5 },
      { d: "M52 30Q59 50 52 70L44 69Q51 50 44 31Z", fill: "#ffffff", stroke: INK, width: 1.5 },
      { d: "M31 38Q35 50 31 62L25 58Q28 50 25 42Z", fill: "#ffffff", stroke: INK, width: 1.5 },
      ...eye(80, 45, 4),
      { d: "M89 53Q86 55 83 54", stroke: INK, width: 1.2 },
    ],
  },
  "blue-tang": {
    parts: [
      { d: "M22 50L5 33L11 50L5 67Z", fill: "#ffd21f", stroke: "#0b1a3a", width: 1.5 },
      { d: "M32 30Q56 14 80 32L74 36Q56 26 36 36Z", fill: "#0b1a3a" },
      { d: "M32 70Q56 86 80 68L74 64Q56 74 36 64Z", fill: "#0b1a3a" },
      { d: "M20 50C24 30 46 24 62 26C80 28 93 40 93 50C93 60 80 72 62 74C46 76 24 70 20 50Z", fill: "#2563ff", stroke: "#0b1a3a", width: 1.5 },
      { d: "M28 46C38 32 64 30 82 40C70 39 56 42 48 50C56 58 66 61 76 63C60 69 42 64 28 55Z", fill: "#0b1a3a" },
      { d: "M24 46Q20 50 24 54L30 52L30 48Z", fill: "#ffd21f" },
      { d: "M60 58Q66 68 58 72Q54 64 60 58Z", fill: "#ffd21f" },
      ...eye(83, 44, 3.6),
    ],
  },
  angelfish: {
    parts: [
      { d: "M52 26Q40 10 24 5Q38 22 42 36Z", fill: "#ffb800", stroke: "#b86e00", width: 1.2 },
      { d: "M52 74Q40 90 24 95Q38 78 42 64Z", fill: "#ffb800", stroke: "#b86e00", width: 1.2 },
      { d: "M36 50L17 37Q22 50 17 63Z", fill: "#ffd84a", stroke: "#b86e00", width: 1.2 },
      { d: "M34 50C36 30 50 22 62 22C78 24 89 38 89 50C89 62 78 76 62 78C50 78 36 70 34 50Z", fill: "#3f7fff", stroke: "#1c3f9a", width: 1.5 },
      { d: "M66 23C80 26 89 38 89 50C89 62 80 74 66 77C72 66 74 58 74 50C74 42 72 32 66 23Z", fill: "#ffd23f" },
      { d: "M50 25Q57 50 50 75", stroke: "#ffe14d", width: 3.5 },
      { d: "M60 23Q67 50 60 77", stroke: "#ffe14d", width: 3 },
      { d: circle(73, 31, 3.2), fill: "#0a2a80", stroke: "#7fb2ff", width: 1 },
      ...eye(80, 45, 3.5),
    ],
  },
  pufferfish: {
    parts: [
      { d: star(52, 50, 37, 29, 18), fill: "#e0a400", stroke: "#a87400", width: 1 },
      { d: "M24 50L9 40L12 50L9 60Z", fill: "#ffb000", stroke: "#a87400", width: 1.2 },
      { d: circle(52, 50, 30), fill: "#ffd23f", stroke: "#a87400", width: 1.5 },
      { d: "M26 58Q52 86 79 60Q52 72 26 58Z", fill: "#fff4c2" },
      { d: circle(38, 40, 3), fill: "#b57f00" },
      { d: circle(48, 32, 2.5), fill: "#b57f00" },
      { d: circle(34, 52, 2.2), fill: "#b57f00" },
      { d: circle(56, 40, 2), fill: "#b57f00" },
      { d: "M52 52Q46 62 54 64Q58 58 52 52Z", fill: "#ffb000", stroke: "#a87400", width: 1 },
      ...eye(70, 42, 6.5),
      { d: "M81 54Q85 56 81 59", stroke: INK, width: 1.6 },
    ],
  },
  seahorse: {
    upright: true,
    parts: [
      { d: "M46 42Q32 48 44 60Z", fill: "#ffd27a", stroke: "#c25e00", width: 1.2 },
      {
        d: "M54 12C62 6 72 10 74 16L91 18L91 25L74 27C72 32 66 34 66 38C77 44 79 60 68 70C62 76 58 80 58 86C58 95 45 96 43 88C41 81 50 79 51 85C50 79 54 73 52 68C44 60 42 46 46 38C48 30 46 20 54 12Z",
        fill: "#ff9d2e",
        stroke: "#c25e00",
        width: 1.8,
      },
      { d: "M55 12L56 4L60 9L63 3L64 11Z", fill: "#ff9d2e", stroke: "#c25e00", width: 1.2 },
      { d: "M67 44L59 46M69 52L59 54M67 60L57 61M62 68L54 66", stroke: "#c25e00", width: 1.4 },
      { d: "M58 40C64 48 64 60 56 68", stroke: "#ffd27a", width: 3 },
      ...eye(65, 19, 3.2),
    ],
  },
  octopus: {
    upright: true,
    parts: [
      ...tentacles(),
      { d: "M28 48C24 16 76 16 72 48C72 57 63 60 50 60C37 60 28 57 28 48Z", fill: "#ff5a5f", stroke: "#c2353d", width: 1.6 },
      { d: circle(40, 30, 3), fill: "#ff9a9d" },
      { d: circle(58, 26, 2.2), fill: "#ff9a9d" },
      { d: circle(62, 36, 1.8), fill: "#ff9a9d" },
      ...eye(41, 46, 5),
      ...eye(59, 46, 5),
      { d: "M46 54Q50 57 54 54", stroke: "#8f1f27", width: 1.4 },
    ],
  },
  squid: {
    parts: [
      { d: "M32 46Q18 38 5 42", stroke: "#ff6fae", width: 3 },
      { d: "M32 49Q18 48 4 52", stroke: "#ff6fae", width: 2.6 },
      { d: "M32 52Q20 60 6 60", stroke: "#ff6fae", width: 3 },
      { d: "M32 55Q22 68 10 70", stroke: "#ff6fae", width: 2.4 },
      { d: "M78 42L90 27L95 50Z", fill: "#ff6fae", stroke: "#d24a8e", width: 1.2 },
      { d: "M78 58L90 73L95 50Z", fill: "#ff6fae", stroke: "#d24a8e", width: 1.2 },
      { d: "M40 40C60 33 80 37 96 50C80 63 60 67 40 60Z", fill: "#ff8fc0", stroke: "#d24a8e", width: 1.5 },
      { d: ellipse(36, 50, 8, 10), fill: "#ff8fc0", stroke: "#d24a8e", width: 1.5 },
      { d: circle(56, 46, 2), fill: "#e0559a" },
      { d: circle(66, 53, 2.4), fill: "#e0559a" },
      { d: circle(76, 47, 1.8), fill: "#e0559a" },
      ...eye(37, 47, 3.6),
    ],
  },
  jellyfish: {
    upright: true,
    parts: [
      ...jellyTentacles(),
      { d: "M45 50Q40 70 50 88", stroke: "#a259ff", width: 5, opacity: 0.85 },
      { d: "M55 50Q60 68 52 84", stroke: "#a259ff", width: 4, opacity: 0.85 },
      {
        d: "M18 50C18 18 82 18 82 50Q77 55 72 50Q66 55 61 50Q55 55 50 50Q45 55 39 50Q34 55 28 50Q23 55 18 50Z",
        fill: "#c58bff",
        stroke: "#8f4fe0",
        width: 1.4,
        opacity: 0.95,
      },
      { d: "M28 40C30 26 48 22 60 25C46 28 36 34 34 44Z", fill: "#ffffff", opacity: 0.55 },
      { d: circle(42, 40, 2.2), fill: "#4b1d8f" },
      { d: circle(58, 40, 2.2), fill: "#4b1d8f" },
      { d: "M46 45Q50 48 54 45", stroke: "#4b1d8f", width: 1.3 },
    ],
  },
  "sea-turtle": {
    parts: [
      { d: "M58 36C66 18 80 11 89 13C81 22 73 32 66 41Z", fill: "#7ad07a", stroke: "#2f7a3f", width: 1.2 },
      { d: "M31 39C24 29 16 26 9 28C15 35 22 41 30 45Z", fill: "#7ad07a", stroke: "#2f7a3f", width: 1.2 },
      { d: "M58 64C64 77 74 85 83 87C77 77 71 67 65 60Z", fill: "#7ad07a", stroke: "#2f7a3f", width: 1.2 },
      { d: "M31 61C24 70 18 74 11 74C17 66 24 60 30 55Z", fill: "#7ad07a", stroke: "#2f7a3f", width: 1.2 },
      { d: "M25 50L15 47L15 53Z", fill: "#7ad07a" },
      { d: "M73 44C82 39 95 43 95 50C95 57 82 61 73 56Z", fill: "#7ad07a", stroke: "#2f7a3f", width: 1.2 },
      { d: "M23 50C23 34 40 27 52 27C67 27 79 38 79 50C79 62 67 73 52 73C40 73 23 66 23 50Z", fill: "#2e8b57", stroke: "#1d5e3a", width: 1.8 },
      { d: "M44 42L52 38L60 42L60 54L52 58L44 54Z", fill: "#45b878", stroke: "#1d5e3a", width: 1.3 },
      { d: "M44 42L33 36M60 42L70 37M60 54L70 63M44 54L33 64M52 38L52 28M52 58L52 72M44 48L24 49M60 48L78 49", stroke: "#1d5e3a", width: 1.3 },
      ...eye(86, 47, 2.6),
    ],
  },
  dolphin: {
    parts: [
      { d: "M15 50L2 37Q8 50 2 63Z", fill: "#5aa0e6", stroke: "#2f6aa8", width: 1.3 },
      { d: "M44 34Q49 18 61 15Q56 25 60 33Z", fill: "#4f8fd6", stroke: "#2f6aa8", width: 1.3 },
      { d: "M10 50C20 40 34 34 54 32C70 31 82 37 88 44L99 48L89 53C80 61 64 64 48 62C30 60 18 56 10 50Z", fill: "#5aa0e6", stroke: "#2f6aa8", width: 1.6 },
      { d: "M30 56C46 62 70 62 88 52C74 58 50 59 30 56Z", fill: "#dbe9ff" },
      { d: "M58 56Q56 68 48 73Q60 67 66 58Z", fill: "#4f8fd6", stroke: "#2f6aa8", width: 1.2 },
      ...eye(80, 44, 2.6),
      { d: "M90 51Q85 53 81 51", stroke: "#2f6aa8", width: 1.2 },
    ],
  },
  orca: {
    parts: [
      { d: "M15 50L2 35Q8 50 2 65Z", fill: "#15171c" },
      { d: "M46 32Q48 10 56 3Q56 20 62 31Z", fill: "#15171c" },
      { d: "M12 50C20 38 40 30 60 30C80 30 95 40 95 50C95 60 80 68 60 68C40 68 20 62 12 50Z", fill: "#15171c", stroke: "#000000", width: 1.2 },
      { d: "M38 60C56 71 82 67 93 54C80 59 62 61 38 60Z", fill: "#ffffff" },
      { d: ellipse(75, 41, 7, 3.6), fill: "#ffffff" },
      { d: "M42 34Q52 39 62 33", stroke: "#9aa3ad", width: 2.4 },
      { d: "M62 60Q60 74 52 79Q64 72 70 62Z", fill: "#15171c" },
      { d: "M95 52Q88 55 82 54", stroke: "#9aa3ad", width: 1 },
    ],
  },
  whale: {
    parts: [
      { d: "M24 52C14 46 9 36 4 29C12 31 17 34 21 40C21 32 23 25 28 21C28 31 28 40 30 48Z", fill: "#3b6fd4", stroke: "#24479a", width: 1.3 },
      { d: "M20 54C20 36 40 27 62 27C82 27 97 40 97 56C97 68 84 77 64 77C42 77 26 68 20 54Z", fill: "#3b6fd4", stroke: "#24479a", width: 1.6 },
      { d: "M44 66C60 77 85 75 95 62C84 70 62 72 44 66Z", fill: "#bcd3ff" },
      { d: "M58 70L60 74M66 71L67 75M74 71L74 75M82 69L81 73", stroke: "#7f9fe0", width: 1 },
      { d: "M60 66Q58 81 47 85Q62 81 68 68Z", fill: "#3b6fd4", stroke: "#24479a", width: 1.2 },
      { d: "M70 22Q66 12 60 10M70 22Q72 10 78 8M70 22Q74 14 82 14", stroke: "#bfe6ff", width: 2 },
      ...eye(82, 51, 3),
      { d: "M97 58Q85 63 72 60", stroke: "#24479a", width: 1.4 },
    ],
  },
  shark: {
    parts: [
      { d: "M19 48L4 23Q10 44 14 50Q10 58 6 73Z", fill: "#8a9bb0", stroke: "#56677c", width: 1.3 },
      { d: "M47 36L56 13L65 36Z", fill: "#7a8ba0", stroke: "#56677c", width: 1.3 },
      { d: "M14 50C24 40 44 34 64 34C80 34 92 42 99 50C92 56 80 62 64 62C44 62 24 58 14 50Z", fill: "#8a9bb0", stroke: "#56677c", width: 1.6 },
      { d: "M30 56C48 63 76 62 94 52C80 58 52 60 30 56Z", fill: "#eef2f7" },
      { d: "M60 58L51 77L71 60Z", fill: "#7a8ba0", stroke: "#56677c", width: 1.2 },
      { d: "M73 44Q71 50 73 56M77 44Q75 50 77 56M81 44Q79 50 81 56", stroke: "#56677c", width: 1.2 },
      ...eye(87, 45, 2.4),
      { d: "M97 52Q89 57 80 55", stroke: "#56677c", width: 1.4 },
      { d: "M92 54L91 56M88 55L87 57M84 55L84 57", stroke: "#ffffff", width: 1 },
    ],
  },
  "manta-ray": {
    parts: [
      { d: "M26 50L2 50", stroke: "#2f3f6b", width: 2 },
      { d: "M92 50C80 40 68 20 52 5C54 24 44 40 22 50C44 60 54 76 52 95C68 80 80 60 92 50Z", fill: "#2f3f6b", stroke: "#1b2645", width: 1.4 },
      { d: "M86 50C76 44 66 38 54 36C48 44 40 48 30 50C40 52 48 56 54 64C66 62 76 56 86 50Z", fill: "#4e6aa8" },
      { d: "M64 26Q70 36 77 41M64 74Q70 64 77 59", stroke: "#dfe8ff", width: 2.4 },
      { d: "M89 46L99 39L95 48Z", fill: "#2f3f6b" },
      { d: "M89 54L99 61L95 52Z", fill: "#2f3f6b" },
      { d: circle(87, 44, 1.6), fill: "#ffffff" },
      { d: circle(87, 56, 1.6), fill: "#ffffff" },
    ],
  },
  stingray: {
    parts: [
      { d: "M30 50L2 46", stroke: "#9c6a2c", width: 3 },
      { d: "M12 47L5 41L7 48Z", fill: "#9c6a2c" },
      { d: "M95 50C95 30 70 18 50 18C36 18 26 30 26 50C26 70 36 82 50 82C70 82 95 70 95 50Z", fill: "#e8b062", stroke: "#9c6a2c", width: 1.6 },
      { d: circle(44, 34, 3), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(58, 28, 2.4), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(40, 56, 3.4), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(54, 68, 2.6), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(66, 60, 3), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(62, 42, 2.2), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      { d: circle(48, 46, 2), fill: "#2aa3ff", stroke: "#0b6fc2", width: 0.8 },
      ...eye(80, 42, 2.8),
      ...eye(80, 58, 2.8),
    ],
  },
  starfish: {
    upright: true,
    parts: [
      { d: star(50, 52, 44, 19, 5), fill: "#ff6b6b", stroke: "#c94040", width: 2.4 },
      { d: star(50, 52, 30, 13, 5), fill: "#ff8a6b", opacity: 0.8 },
      { d: circle(50, 22, 2), fill: "#ffd1c4" },
      { d: circle(76, 44, 2), fill: "#ffd1c4" },
      { d: circle(24, 44, 2), fill: "#ffd1c4" },
      { d: circle(66, 75, 2), fill: "#ffd1c4" },
      { d: circle(34, 75, 2), fill: "#ffd1c4" },
      ...eye(44, 48, 3.2),
      ...eye(56, 48, 3.2),
      { d: "M46 57Q50 60 54 57", stroke: "#8f2a2a", width: 1.4 },
    ],
  },
  crab: {
    upright: true,
    parts: [
      { d: "M30 62L14 66L9 77M32 66L18 74L16 84M68 62L86 66L91 77M68 66L82 74L84 84", stroke: "#d6332a", width: 3 },
      { d: "M32 52L20 39M68 52L80 39", stroke: "#d6332a", width: 4 },
      { d: "M20 39C8 37 5 22 16 17L20 28L24 19C31 23 29 37 20 39Z", fill: "#ff4b3e", stroke: "#b32218", width: 1.4 },
      { d: "M80 39C92 37 95 22 84 17L80 28L76 19C69 23 71 37 80 39Z", fill: "#ff4b3e", stroke: "#b32218", width: 1.4 },
      { d: "M44 47L42 36M56 47L58 36", stroke: "#b32218", width: 2 },
      { d: "M20 58C20 42 80 42 80 58C80 68 65 75 50 75C35 75 20 68 20 58Z", fill: "#ff4b3e", stroke: "#b32218", width: 1.8 },
      { d: "M30 52Q50 46 70 52", stroke: "#ff8a80", width: 2 },
      ...eye(42, 33, 3.8),
      ...eye(58, 33, 3.8),
      { d: "M43 63Q50 68 57 63", stroke: "#7a140c", width: 1.6 },
    ],
  },
  lobster: {
    parts: [
      { d: "M18 50L3 39L6 50L3 61Z", fill: "#e04a1f", stroke: "#a8300f", width: 1.2 },
      { d: "M58 62L54 71M64 62L62 71M70 60L70 69M58 38L54 29M64 38L62 29", stroke: "#c43c14", width: 1.8 },
      { d: ellipse(23, 50, 6.5, 9), fill: "#e85a2a", stroke: "#a8300f", width: 1.3 },
      { d: ellipse(33, 50, 7, 10), fill: "#e85a2a", stroke: "#a8300f", width: 1.3 },
      { d: ellipse(43, 50, 7, 11), fill: "#e85a2a", stroke: "#a8300f", width: 1.3 },
      { d: "M48 50C48 40 58 36 68 38C76 40 81 46 81 50C81 54 76 60 68 62C58 64 48 60 48 50Z", fill: "#e85a2a", stroke: "#a8300f", width: 1.5 },
      { d: "M72 41Q80 31 84 27M72 59Q80 69 84 73", stroke: "#c43c14", width: 4 },
      { d: "M84 27C89 16 100 17 98 26L90 26L98 30C96 37 86 35 84 27Z", fill: "#e85a2a", stroke: "#a8300f", width: 1.3 },
      { d: "M84 73C89 84 100 83 98 74L90 74L98 70C96 63 86 65 84 73Z", fill: "#e85a2a", stroke: "#a8300f", width: 1.3 },
      { d: "M80 47Q90 40 99 43M80 53Q90 60 99 57", stroke: "#a8300f", width: 1.1 },
      ...eye(75, 46, 2.4),
    ],
  },
  shrimp: {
    parts: [
      { d: "M34 68L22 82L38 79L41 72Z", fill: "#ff7a6b", stroke: "#d9604f", width: 1.2 },
      { d: "M50 45L48 54M58 44L58 53M66 45L68 54", stroke: "#d9604f", width: 1.6 },
      { d: "M87 40C81 26 60 19 42 23C26 27 15 40 17 56C19 66 28 73 35 70C30 62 31 52 39 46C51 38 68 40 78 50Z", fill: "#ff9a8b", stroke: "#d9604f", width: 1.6 },
      { d: "M40 25Q35 36 33 47M52 22Q50 33 46 41M64 23Q64 33 60 40M74 28Q74 36 70 42", stroke: "#d9604f", width: 1.3 },
      { d: "M87 40Q96 29 100 16M87 42Q98 40 100 33", stroke: "#d9604f", width: 1.1 },
      ...eye(80, 39, 2.8),
    ],
  },
  narwhal: {
    parts: [
      { d: "M80 44L99 33L82 48Z", fill: "#f4ecd2", stroke: "#b9a77a", width: 1 },
      { d: "M85 41L86 44M89 39L90 42M93 37L94 39", stroke: "#b9a77a", width: 0.9 },
      { d: "M15 50L2 40Q6 50 2 60Z", fill: "#8fb0d0", stroke: "#57789a", width: 1.3 },
      { d: "M10 50C18 38 38 32 56 32C72 32 85 42 85 52C85 62 72 68 54 68C36 68 18 62 10 50Z", fill: "#8fb0d0", stroke: "#57789a", width: 1.6 },
      { d: "M30 60C46 68 70 66 83 56C70 62 50 64 30 60Z", fill: "#dbe7f3" },
      { d: circle(30, 44, 2), fill: "#57789a", opacity: 0.7 },
      { d: circle(40, 38, 2.4), fill: "#57789a", opacity: 0.7 },
      { d: circle(52, 40, 1.8), fill: "#57789a", opacity: 0.7 },
      { d: circle(46, 48, 1.6), fill: "#57789a", opacity: 0.7 },
      { d: circle(60, 36, 1.6), fill: "#57789a", opacity: 0.7 },
      { d: "M54 62Q52 74 44 77Q56 72 60 62Z", fill: "#8fb0d0", stroke: "#57789a", width: 1.2 },
      ...eye(73, 47, 2.4),
    ],
  },
};

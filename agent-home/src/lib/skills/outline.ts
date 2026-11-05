/** Heading outline + stable ids shared by the rendered document and "On this page". */

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Markdown inline syntax → the text a reader sees. */
export function plainHeadingText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .trim();
}

// Built with the constructor: the Babel regex transform rejects `\p{L}` literals.
const NON_WORD = new RegExp("[^\\p{L}\\p{N}\\s_-]", "gu");

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(NON_WORD, "")
    .trim()
    .replace(/\s+/g, "-");
  return `sec-${slug || "section"}`;
}

/** Hands out unique ids in document order (`x`, `x-1`, `x-2`, …). */
export function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** ATX headings h1–h6 outside fenced code, ids assigned the same way the renderer does. */
export function extractHeadings(md: string, maxLevel = 3): Heading[] {
  const next = slugger();
  const out: Heading[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) continue;
    const text = plainHeadingText(m[2]);
    const id = next(text);
    if (m[1].length <= maxLevel) out.push({ level: m[1].length, text, id });
  }
  return out;
}

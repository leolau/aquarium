/** Markdown toolbar actions on a textarea's value + selection. */

export type FormatKind = "heading" | "bold" | "italic" | "code" | "codeblock" | "list" | "numbered" | "link" | "table";

export interface Edit {
  text: string;
  start: number;
  end: number;
}

function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  return [from, nl < 0 ? text.length : nl];
}

function wrap(text: string, start: number, end: number, before: string, after: string, placeholder: string): Edit {
  const sel = text.slice(start, end) || placeholder;
  const next = text.slice(0, start) + before + sel + after + text.slice(end);
  return { text: next, start: start + before.length, end: start + before.length + sel.length };
}

function prefixLines(text: string, start: number, end: number, prefix: (k: number) => string, strip: RegExp): Edit {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const all = lines.every((l) => strip.test(l));
  const out = lines.map((l, k) => (all ? l.replace(strip, "") : prefix(k) + l)).join("\n");
  return { text: text.slice(0, from) + out + text.slice(to), start: from, end: from + out.length };
}

const TABLE = "| Column | Column |\n| --- | --- |\n| Value | Value |";

export function applyFormat(text: string, start: number, end: number, kind: FormatKind): Edit {
  switch (kind) {
    case "bold":
      return wrap(text, start, end, "**", "**", "bold text");
    case "italic":
      return wrap(text, start, end, "*", "*", "italic text");
    case "code":
      return wrap(text, start, end, "`", "`", "code");
    case "link": {
      const sel = text.slice(start, end) || "link text";
      const ins = `[${sel}](https://)`;
      const urlAt = start + sel.length + 3;
      return { text: text.slice(0, start) + ins + text.slice(end), start: urlAt, end: urlAt + 8 };
    }
    case "heading":
      return prefixLines(text, start, end, () => "## ", /^#{1,6} /);
    case "list":
      return prefixLines(text, start, end, () => "- ", /^- /);
    case "numbered":
      return prefixLines(text, start, end, (k) => `${k + 1}. `, /^\d+\. /);
    case "codeblock":
    case "table": {
      const sel = text.slice(start, end);
      const block = kind === "table" ? TABLE : `\`\`\`\n${sel || "code"}\n\`\`\``;
      const lead = start === 0 || text[start - 1] === "\n" ? "" : "\n";
      const tail = text[end] === "\n" || end === text.length ? "" : "\n";
      const next = text.slice(0, start) + lead + block + tail + text.slice(end);
      const innerStart = start + lead.length + (kind === "table" ? 0 : 4);
      return { text: next, start: innerStart, end: innerStart + (kind === "table" ? block.length : (sel || "code").length) };
    }
  }
}

"use client";

import type { Element, ElementContent, Root, RootContent } from "hast";
import Markdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { CopyButton } from "@/components/skills/CopyButton";
import { slugger } from "@/lib/skills/outline";

type Node = Root | RootContent | ElementContent;

function textOf(node: Node): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return (node.children as Node[]).map(textOf).join("");
  return "";
}

function walk(node: Node, visit: (el: Element) => void) {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children as Node[]) walk(child, visit);
}

const CALLOUT_LABEL: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const CALLOUT_RE = /^\s*\[!(note|tip|important|warning|caution)\]\s*/i;

/**
 * Runs after `rehype-sanitize` so the ids and callout markers it adds are not
 * clobbered. Heading ids come from the same slugger as `extractHeadings`, so
 * "On this page" links land on the rendered headings.
 */
function rehypeSkillDoc() {
  return (tree: Root) => {
    const next = slugger();
    walk(tree, (el) => {
      if (/^h[1-6]$/.test(el.tagName)) {
        el.properties = { ...el.properties, id: next(textOf(el).trim()) };
      } else if (el.tagName === "blockquote") {
        const para = el.children.find((c): c is Element => c.type === "element");
        const first = para?.tagName === "p" ? para.children[0] : undefined;
        const m = first?.type === "text" ? CALLOUT_RE.exec(first.value) : null;
        if (para && first?.type === "text" && m) {
          const kind = m[1].toLowerCase();
          first.value = first.value.slice(m[0].length);
          if (!first.value) para.children.shift();
          para.children.unshift({ type: "element", tagName: "b", properties: { className: ["mr-1"] }, children: [{ type: "text", value: `${CALLOUT_LABEL[kind]}:` }] });
          el.properties = { ...el.properties, dataCallout: kind };
        }
      }
    });
  };
}


const COMPONENTS: Components = {
  h1: ({ children, id }) => (
    <h1 id={id} className="mb-2.5 scroll-mt-20 text-xl font-semibold">
      {children}
    </h1>
  ),
  h2: ({ children, id }) => (
    <h2 id={id} className="mb-2 mt-6 scroll-mt-20 border-t border-[var(--color-border)] pt-3 text-base font-semibold first:mt-0 first:border-t-0 first:pt-0">
      {children}
    </h2>
  ),
  h3: ({ children, id }) => (
    <h3 id={id} className="mb-1.5 mt-4 scroll-mt-20 text-sm font-semibold">
      {children}
    </h3>
  ),
  h4: ({ children, id }) => (
    <h4 id={id} className="mb-1 mt-3 scroll-mt-20 text-sm font-semibold text-[var(--color-muted)]">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  hr: () => <hr className="my-4 border-[var(--color-border)]" />,
  a: ({ children, href }) => {
    const url = typeof href === "string" ? href : "";
    if (url.startsWith("#"))
      return (
        <a href={url} className="text-[var(--color-accent)] underline underline-offset-2">
          {children}
        </a>
      );
    if (/^(https?:|mailto:)/i.test(url))
      return (
        <a href={url} target="_blank" rel="noreferrer noopener" className="text-[var(--color-accent)] underline underline-offset-2">
          {children}
        </a>
      );
    // Relative links point at files inside the skill folder; there is nothing to open.
    return (
      <span title={url} className="underline decoration-dotted underline-offset-2">
        {children}
      </span>
    );
  },
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : "";
    if (!/^https:/i.test(url)) return <span className="text-[var(--color-muted)]">[{alt || "image"}]</span>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt || ""} className="my-2 max-h-96 max-w-full rounded-lg" />;
  },
  blockquote: ({ children, node }) => {
    const kind = typeof node?.properties?.dataCallout === "string" ? node.properties.dataCallout : null;
    const warn = kind === "warning" || kind === "caution";
    return (
      <blockquote
        data-callout={kind ?? "quote"}
        className={`my-2.5 rounded-r-xl border-l-[3px] px-3 py-2.5 text-[13px] [&>p]:my-1 ${
          warn
            ? "border-amber-500 bg-amber-500/10"
            : "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
        }`}
      >
        {children}
      </blockquote>
    );
  },
  code: ({ className, children }) => {
    if ((className ?? "").includes("language-") || String(children).includes("\n"))
      return <code className={`${className ?? ""} font-mono`}>{children}</code>;
    return (
      <code className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 font-mono text-[12.5px]">
        {children}
      </code>
    );
  },
  pre: ({ children, node }) => {
    const code = node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
    const classes = code?.properties?.className;
    const lang = (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);
    const text = code ? textOf(code).replace(/\n$/, "") : "";
    return (
      <div data-component="SkillCodeBlock" className="relative my-2.5">
        {lang ? (
          <span className="pointer-events-none absolute right-2.5 top-1.5 text-[11px] text-[#8b93a7]">{lang}</span>
        ) : null}
        <pre className="overflow-x-auto rounded-xl bg-[#14171f] px-3.5 pb-8 pt-3 font-mono text-[12.5px] leading-[1.55] text-[#d6dbe6]">
          {children}
        </pre>
        <CopyButton
          text={text}
          className="absolute bottom-2 right-2.5 !min-h-0 rounded-md bg-[#262b37] px-2 py-0.5 text-[11px] text-[#c9d1e0]"
        />
      </div>
    );
  },
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-[var(--color-border)] p-2 text-left text-xs font-medium text-[var(--color-muted)]">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-[var(--color-border)] p-2 align-top">{children}</td>,
};

/**
 * A SKILL.md body rendered as a document. Same Markdown stack as chat's
 * `RichText` (GFM + raw HTML through `rehype-sanitize`, so markup in a skill
 * can't run script), with heading anchors, callouts and copyable code blocks.
 */
export function SkillMarkdown({ markdown }: { markdown: string }) {
  return (
    <div data-component="SkillMarkdown" className="text-sm leading-relaxed [overflow-wrap:anywhere]">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeSkillDoc]} components={COMPONENTS}>
        {markdown}
      </Markdown>
    </div>
  );
}

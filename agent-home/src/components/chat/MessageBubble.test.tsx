import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/chat/MessageBubble";

describe("MessageBubble", () => {
  it("renders a user turn aligned right with its text", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ role: "user", content: "hello agent" }} />,
    );
    expect(html).toContain('data-component="MessageBubble"');
    expect(html).toContain("justify-end");
    expect(html).toContain("hello agent");
  });

  it("labels a user message sent while the agent was working", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ id: 3, role: "user", content: "Use the Q3 numbers", sentWhileWorking: true }}
      />,
    );
    expect(html).toContain("justify-end");
    expect(html).toContain('data-sent-while-working="true"');
    expect(html).toContain("Sent while working");
    expect(html).toContain("Use the Q3 numbers");
  });

  it("does not label an ordinary user turn", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ role: "user", content: "hello agent" }} />,
    );
    expect(html).not.toContain("Sent while working");
    expect(html).not.toContain("data-sent-while-working");
  });

  it("renders an assistant turn aligned left", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ role: "assistant", content: "how can I help?" }} />,
    );
    expect(html).toContain("justify-start");
    expect(html).toContain("how can I help?");
  });

  it("renders assistant Markdown (headings, tables, emphasis) as HTML", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content:
            "## Tenders\n\n**Bold** and a table:\n\n| Name | Due |\n| --- | --- |\n| CUHK | Today |",
        }}
      />,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("CUHK");
  });

  it("sanitizes dangerous HTML in an assistant reply (fail-closed)", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content:
            'Safe <b>bold</b> but <script>alert(1)</script> and <a href="javascript:alert(2)">x</a> and <img src="x" onerror="alert(3)">',
        }}
      />,
    );
    // Allowed inline HTML survives; scripts, javascript: URLs and inline event
    // handlers are stripped by rehype-sanitize.
    expect(html).toContain("<b>bold</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
  });

  it("routes an assistant private-bucket media ref through the signing route", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content: "here ![shot](/api/chat/media?path=mia_member%2Fhome_2%2Fu1-a.png)",
        }}
      />,
    );
    expect(html).toContain('data-component="ChatMedia"');
    expect(html).not.toContain("<img");
  });

  it("routes a private-bucket media ref through the signing route", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "user",
          content:
            "look ![shot](/api/chat/media?path=mia_member%2Fhome_2%2Fu1-a.png)",
        }}
      />,
    );
    expect(html).toContain('data-component="ChatMedia"');
    // The private object path is never rendered as an image src — the signed
    // URL is fetched from the BFF after the server-side ownership check.
    expect(html).not.toContain("<img");
    expect(html).toContain("Loading shot");
  });

  it("renders inline image attachments as <img> media", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "user",
          content: "look at this ![shot](https://cdn.test/a.png)",
        }}
      />,
    );
    expect(html).toContain("look at this");
    expect(html).toContain('src="https://cdn.test/a.png"');
    expect(html).toContain('alt="shot"');
  });

  it("renders a non-image attachment ref as a download chip, not an image", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "user",
          content:
            "see [report.pdf](/api/chat/media?path=mia_member%2Fhome_2%2Fu1-report.pdf)",
        }}
      />,
    );
    expect(html).toContain('data-component="ChatFile"');
    expect(html).toContain("report.pdf");
    // A document ref is never rendered as an <img> (would show broken).
    expect(html).not.toContain("<img");
  });

  it("leaves a plain (non-media) link as literal text", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{ role: "user", content: "see [docs](https://example.com)" }}
      />,
    );
    expect(html).not.toContain('data-component="ChatFile"');
    expect(html).toContain("[docs](https://example.com)");
  });

  it("hides the injected app-context line from user bubbles", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "user",
          content:
            "[app context: page /projects/x · last active: none]\nCan you check?",
        }}
      />,
    );
    expect(html).not.toContain("[app context:");
    expect(html).toContain("Can you check?");
  });

  it("hides the attachment note, inlined file text and cache path after a reload", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          id: 9,
          role: "user",
          content:
            "[The user sent a text document: 'notes.txt'. Its content has been included below. " +
            "The file is also saved at: /home/hermes/.hermes/cache/documents/doc_1a2b_notes.txt]" +
            "\n\n--- notes.txt ---\nsecret file body\n\n" +
            "[app context: page /chat · last active: none]\nsummarise the file\n\n" +
            "[notes.txt](/api/chat/media?path=u%2Fnotes.txt)",
        }}
      />,
    );
    expect(html).not.toContain("[app context:");
    expect(html).not.toContain("The user sent");
    expect(html).not.toContain("cache/documents");
    expect(html).not.toContain("secret file body");
    expect(html).toContain("summarise the file");
    expect(html).toContain("notes.txt");
  });

  it("renders a compaction summary as a muted divider, never as a bubble", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content:
            "[CONTEXT COMPACTION — REFERENCE ONLY] Model: GLM-5.2.\n" +
            "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
        }}
      />,
    );
    expect(html).toContain('data-component="CompactionDivider"');
    expect(html).not.toContain('data-component="MessageBubble"');
    expect(html).not.toContain("GLM-5.2");
  });

  it("keeps the original reply readable when a summary is merged into it", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content:
            "[PRIOR CONTEXT — for reference only; not a new message]\nThe run is healthy.\n\n" +
            "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n" +
            "[CONTEXT COMPACTION — REFERENCE ONLY] Model: GLM-5.2.\n" +
            "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
        }}
      />,
    );
    expect(html).toContain('data-component="CompactionDivider"');
    expect(html).toContain("The run is healthy.");
    expect(html).not.toContain("GLM-5.2");
  });

  it("shows persisted assistant reasoning collapsed", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          role: "assistant",
          content: "The run is healthy.",
          reasoning: "Let me check the run state…",
        }}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("Reasoning");
    expect(html).toContain("Let me check the run state…");
  });

  it("lets off-screen rows skip layout via content-visibility", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={{ role: "user", content: "hi" }} />,
    );
    expect(html).toContain("content-visibility:auto");
    expect(html).toContain("contain-intrinsic-size:auto 120px");
  });

  it("offers a Copy button on assistant replies only", () => {
    const assistant = renderToStaticMarkup(
      <MessageBubble message={{ role: "assistant", content: "done" }} />,
    );
    expect(assistant).toContain('aria-label="Copy reply"');
    const user = renderToStaticMarkup(
      <MessageBubble message={{ role: "user", content: "hi" }} />,
    );
    expect(user).not.toContain("Copy reply");
  });
});

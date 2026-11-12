import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ShellFrame } from "@/components/ShellFrame";

describe("ShellFrame chatChrome", () => {
  it("drops the launcher clearance on phones and marks the top bar collapsible", () => {
    const html = renderToStaticMarkup(
      <ShellFrame title="Chat" fill clearLauncher chatChrome topBar={<div>bar</div>}>
        x
      </ShellFrame>,
    );
    expect(html).toContain('data-chat-chrome="true"');
    expect(html).toContain('data-chat-chrome="collapsible"');
    expect(html).not.toContain("--coral-clearance");
    expect(html).toContain("lg:pb-8");
  });

  it("keeps the launcher clearance elsewhere", () => {
    const html = renderToStaticMarkup(
      <ShellFrame title="Files" clearLauncher topBar={<div>bar</div>}>
        x
      </ShellFrame>,
    );
    expect(html).not.toContain("data-chat-chrome");
    expect(html).toContain("--coral-clearance");
  });
});

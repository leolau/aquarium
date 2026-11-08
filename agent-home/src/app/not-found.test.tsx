import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/x", useRouter: () => ({ back() {}, push() {} }) }));
vi.mock("@/lib/auth/principal", () => ({ getPrincipal: async () => null }));
vi.mock("@/i18n/server", async () => {
  const { createTranslator } = await import("@/i18n/translate");
  const errors = (await import("@/i18n/messages/en/errors.json")).default;
  return { getT: async (ns: string) => createTranslator({ errors }, ns) };
});

import NotFound from "@/app/not-found";

describe("app/not-found", () => {
  it("renders the shell without the launcher for a signed-out visitor", async () => {
    const shell = (await NotFound()) as ReactElement<{ showCoral: boolean; title: string }>;
    expect(shell.props.showCoral).toBe(false);
    expect(shell.props.title).toBe("Page not found");
    const html = renderToStaticMarkup((shell.props as unknown as { children: ReactElement }).children);
    expect(html).toContain('data-kind="notFound"');
  });
});

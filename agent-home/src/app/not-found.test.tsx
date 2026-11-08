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
import { AuthLayout } from "@/components/auth/AuthLayout";
import { MobileShell } from "@/components/MobileShell";

describe("app/not-found", () => {
  it("gives a signed-out visitor the auth layout (no launcher) and Sign in", async () => {
    const page = (await NotFound()) as ReactElement<{ children: ReactElement }>;
    expect(page.type).toBe(AuthLayout);
    expect(page.type).not.toBe(MobileShell);
    const html = renderToStaticMarkup(page.props.children);
    expect(html).toContain('data-kind="notFound"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Or jump to");
  });
});

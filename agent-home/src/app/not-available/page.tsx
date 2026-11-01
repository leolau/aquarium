import Link from "next/link";

import "@/components/coral/coral-apps";
import { getApps } from "@/components/coral/coral-registry";
import { MobileShell } from "@/components/MobileShell";
import { requirePrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/**
 * Shown in place of a page whose menu item is hidden from the caller's role
 * (Settings → Menu). The middleware rewrites the request here, so the address
 * bar keeps the original URL.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  await requirePrincipal();
  const { app } = await searchParams;
  const name = getApps().find((a) => a.id === app)?.name;
  return (
    <MobileShell title="Not available">
      <section
        data-component="NotAvailableForRole"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center"
      >
        <p className="text-base font-medium">
          {name ? `${name} isn't available for your role.` : "This page isn't available for your role."}
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The owner or an admin chooses which menu items each role sees. Ask them if you need it.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          Go home
        </Link>
      </section>
    </MobileShell>
  );
}

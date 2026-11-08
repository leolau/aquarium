import Link from "next/link";

import { HUB_ICONS } from "@/components/system/SystemHub";

/** Figma 32:3428: the friendly "for admins" state an admin-only System page shows instead of a raw 403. */
export function LockedState({ title, body, hint, back }: { title: string; body: string; hint: string; back: string }) {
  return (
    <section
      data-component="LockedState"
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
    >
      <span className="text-[var(--color-fg)] [&_svg]:h-9 [&_svg]:w-9">{HUB_ICONS.core}</span>
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{title}</h2>
      <p className="text-sm text-[var(--color-muted)]">{body}</p>
      <p className="text-[13px] text-[var(--color-muted)]">{hint}</p>
      <Link
        href="/system"
        data-action="back-to-system"
        className="inline-flex min-h-11 w-full items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-medium text-[var(--color-fg)]"
      >
        {back}
      </Link>
    </section>
  );
}

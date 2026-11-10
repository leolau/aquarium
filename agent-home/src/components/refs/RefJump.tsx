"use client";

import Link from "next/link";

import { parseRef, refHref, type RefKind } from "@/lib/refs";

/**
 * "Open D88" under a search box when what was typed is a short ref of the
 * list's own kind (FG-36): the list already narrows to that item, and this
 * opens it straight away. Renders nothing for anything else.
 */
export function RefJump({
  query,
  kind,
  label,
}: {
  query: string;
  kind: RefKind;
  label: (ref: string) => string;
}) {
  const parsed = parseRef(query);
  if (!parsed || parsed.kind !== kind) return null;
  return (
    <Link
      href={refHref(parsed.ref)}
      data-component="RefJump"
      data-ref={parsed.ref}
      className="self-start rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs"
    >
      {label(parsed.ref)}
    </Link>
  );
}

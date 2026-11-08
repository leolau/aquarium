"use client";

import Link from "next/link";

import { LogoutButton } from "@/components/LogoutButton";

import { UserIcon } from "./icons";
import { usePopover } from "./usePopover";

/** Figma `account` (5:64): initial avatar → account, settings and sign out. */
export function AccountMenu({ name }: { name?: string | null }) {
  const { open: popOpen, setOpen: setPopOpen, ref: popRef } = usePopover();
  const initial = name?.trim()?.[0]?.toUpperCase() ?? null;
  return (
    <div ref={popRef} data-component="AccountMenu" className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={popOpen}
        aria-label={name ? `Account: ${name}` : "Account"}
        data-action="account-open"
        onClick={() => setPopOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[13px] font-medium text-[var(--color-fg)]"
      >
        {initial ?? <UserIcon size={16} />}
      </button>
      {popOpen ? (
        // Above the Coral launchers (z-60): the menu is a stacking context, so the
        // sign-out confirmation inside it is capped at the menu's level.
        <div
          role="menu"
          className="absolute right-0 top-full z-[65] mt-2 w-56 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm shadow-xl"
        >
          {name ? <p className="truncate px-2 py-1 text-xs text-[var(--color-muted)]">Signed in as {name}</p> : null}
          <Link role="menuitem" href="/settings/account" className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]">
            Account
          </Link>
          <Link role="menuitem" href="/settings" className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]">
            Settings
          </Link>
          <LogoutButton />
        </div>
      ) : null}
    </div>
  );
}

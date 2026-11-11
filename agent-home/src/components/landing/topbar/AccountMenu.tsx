"use client";

import Link from "next/link";

import { LogoutButton } from "@/components/LogoutButton";
import { useT } from "@/i18n";
import type { ProfileRole } from "@/lib/api/my-profiles";
import type { Role } from "@/types";

import { ChevronDownIcon, UserIcon } from "@/components/ui/icons";
import { usePopover } from "./usePopover";

/**
 * Figma `account` (5:64): initial avatar → account, settings and sign out.
 * From `md` the trigger also shows the name and the role in the current
 * profile; the menu lists the role in each enrolled profile.
 */
export function AccountMenu({
  name,
  role,
  roles = [],
  currentProfile,
}: {
  name?: string | null;
  /** Role in the current profile (authority is profile-local). */
  role?: Role | null;
  /** Role in each profile the account is actively enrolled in. */
  roles?: ProfileRole[];
  currentProfile?: string;
}) {
  const t = useT("landing");
  const { open: popOpen, setOpen: setPopOpen, ref: popRef } = usePopover();
  const trimmed = name?.trim() || null;
  const initial = trimmed?.[0]?.toUpperCase() ?? null;
  const roleLabel = role ? t(`role.${role}`) : null;
  const label = trimmed
    ? roleLabel
      ? t("account.openNamedRole", { name: trimmed, role: roleLabel })
      : t("account.openNamed", { name: trimmed })
    : t("account.open");
  const showRoleList = roles.length > 0;
  return (
    <div ref={popRef} data-component="AccountMenu" className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={popOpen}
        aria-label={label}
        title={label}
        data-action="account-open"
        onClick={() => setPopOpen((v) => !v)}
        className="inline-flex h-9 max-w-[15rem] items-center gap-2 rounded-full text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] md:pr-2"
      >
        <span
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[13px] font-medium"
        >
          {initial ?? <UserIcon size={16} />}
        </span>
        {trimmed || roleLabel ? (
          <span
            aria-hidden
            data-testid="account-identity"
            data-fit-hide="identity"
            className="hidden min-w-0 flex-col items-start text-left md:flex">
            {trimmed ? <span className="max-w-full truncate text-[13px] font-medium leading-4">{trimmed}</span> : null}
            {roleLabel ? (
              <span className="max-w-full truncate text-[11px] leading-[14px] text-[var(--color-muted)]">{roleLabel}</span>
            ) : null}
          </span>
        ) : null}
        <span data-fit-hide="identity" className="contents">
          <ChevronDownIcon size={14} className="hidden text-[var(--color-muted)] md:block" />
        </span>
      </button>
      {popOpen ? (
        // Above the Coral launchers (z-60): the menu is a stacking context, so the
        // sign-out confirmation inside it is capped at the menu's level.
        <div
          role="menu"
          className="absolute right-0 top-full z-[65] mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm shadow-xl"
        >
          {trimmed || roleLabel ? (
            <div data-testid="account-summary" className="px-2 pb-2 pt-1">
              {trimmed ? (
                <p className="truncate text-xs text-[var(--color-muted)]">{t("account.signedInAs", { name: trimmed })}</p>
              ) : null}
              {roleLabel ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs">
                  <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 font-medium text-[var(--color-fg)]">
                    {roleLabel}
                  </span>
                  {currentProfile && roles.length > 1 ? (
                    <span className="truncate text-[var(--color-muted)]">{currentProfile}</span>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          {showRoleList ? (
            <div data-testid="account-roles" className="mb-1 border-t border-[var(--color-border)] px-2 pb-1 pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)]">
                {t("account.yourRoles")}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {roles.map((r) => (
                  <li key={r.profile} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-[var(--color-fg)]">
                      {r.profile}
                      {r.profile === currentProfile ? (
                        <span className="text-[var(--color-muted)]"> · {t("account.current")}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[var(--color-muted)]">{t(`role.${r.role}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className={trimmed || roleLabel || showRoleList ? "border-t border-[var(--color-border)] pt-1" : undefined}>
            <Link role="menuitem" href="/settings/account" className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]">
              Account
            </Link>
            <Link role="menuitem" href="/settings" className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]">
              Settings
            </Link>
            <Link role="menuitem" href="/system" className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--color-surface-2)]">
              System
            </Link>
            <LogoutButton />
          </div>
        </div>
      ) : null}
    </div>
  );
}

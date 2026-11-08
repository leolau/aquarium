/**
 * Class strings for the signed-out auth screens (Figma `field` 16:113 and
 * `button` 3:23), shared so Login, Setup and Activate look the same.
 */
export const authField =
  "h-11 w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] read-only:opacity-70 focus:border-[var(--color-accent)] focus:outline-none aria-[invalid=true]:border-[var(--color-danger)]";
export const authLabel = "flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]";
export const authHint = "text-xs font-normal text-[var(--color-muted)]";
export const authFieldError = "text-xs font-normal text-[var(--color-danger)]";
export const authPrimary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-60";
export const authSecondary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-medium text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-60";
export const authLink = "font-medium text-[var(--color-accent)] hover:underline";

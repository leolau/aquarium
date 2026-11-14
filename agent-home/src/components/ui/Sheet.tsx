"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * A dismissable modal panel: a bottom sheet on phones, a centred dialog from
 * `sm` up (`side` docks it to the right edge on desktop, like a drawer).
 * Esc, the ✕ and a backdrop tap all close it.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  side = false,
  wide = false,
  full = false,
  mobileFull = false,
  component = "Sheet",
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  side?: boolean;
  wide?: boolean;
  /** Near full-screen on desktop (e.g. a maximized panel). */
  full?: boolean;
  /** Fill the whole screen on phones instead of the bottom-sheet height. */
  mobileFull?: boolean;
  component?: string;
}) {
  const t = useT("common");
  const hydrated = useHydrated();
  const panelRef = useRef<HTMLDivElement>(null);
  // Read during the first render: a child's autoFocus moves focus before effects run.
  const [opener] = useState(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Modal focus: move into the panel, keep Tab inside it, return to the opener.
  useEffect(() => {
    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const frame = requestAnimationFrame(() => {
      if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const frame = side
    ? "sm:items-stretch sm:justify-end sm:p-0"
    : "sm:items-center sm:p-4";
  const panel = side
    ? "sm:h-full sm:max-w-md sm:rounded-none sm:border-y-0 sm:border-r-0"
    : `sm:rounded-2xl ${full ? "sm:h-[90vh] sm:max-w-5xl" : wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`;

  const dialog = (
    <div
      data-component={component}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      className={`fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 ${frame}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`flex w-full flex-col border outline-none ${mobileFull ? "h-[100dvh] max-h-[100dvh]" : "max-h-[92vh] rounded-t-2xl"} border-[var(--color-border)] bg-[var(--color-bg)] sm:max-h-full ${panel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:pb-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
  // On <body>: a Sheet opened from a sticky bar or a stacking context would
  // otherwise sit under page bars and the z-60 launchers.
  return hydrated ? createPortal(dialog, document.body) : dialog;
}

export const inputClass =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

export const primaryButtonClass =
  "rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60";

export const secondaryButtonClass =
  "rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60";

export const dangerButtonClass =
  "rounded-full border border-red-500/40 px-4 py-1.5 text-xs text-red-300 disabled:opacity-60";

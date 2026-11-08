"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { UndoIcon } from "@/components/ui/icons";

export const UNDO_MS = 6000;

interface Pending {
  id: number;
  message: string;
  undo: () => unknown;
}

/**
 * Figma `undo-toast` (16:175). Reversible actions (done, archive, dismiss,
 * pin) act at once, then `show()` offers Undo for six seconds. Undo runs once:
 * the button locks on the first press. On phones the toast sits above the
 * floating launcher.
 */
export function useUndoToast(): { show: (message: string, undo: () => unknown) => void; toast: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const used = useRef(false);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending((p) => (p?.id === pending.id ? null : p)), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const show = useCallback((message: string, undo: () => unknown) => {
    used.current = false;
    setBusy(false);
    setPending({ id: ++seq.current, message, undo });
  }, []);

  const onUndo = async () => {
    if (!pending || used.current) return;
    used.current = true;
    setBusy(true);
    try {
      await pending.undo();
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const toast = (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--coral-clearance)+var(--safe-bottom)+0.5rem)] z-[60] flex justify-center px-4 lg:bottom-6"
    >
      {pending ? (
        <div
          data-component="UndoToast"
          className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm text-[var(--color-fg)] shadow-lg"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{pending.message}</span>
          <button
            type="button"
            data-action="undo"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onUndo}
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-3 font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface)] disabled:opacity-60"
          >
            <UndoIcon size={16} />
            {busy ? "Undoing…" : "Undo"}
          </button>
        </div>
      ) : null}
    </div>
  );

  return { show, toast };
}

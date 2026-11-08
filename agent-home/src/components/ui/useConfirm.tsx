"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export interface AskOptions {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "accent";
}

export interface AskTextOptions extends AskOptions {
  label: string;
  placeholder?: string;
}

type Pending =
  | { kind: "confirm"; opts: AskOptions; resolve: (ok: boolean) => void }
  | { kind: "text"; opts: AskTextOptions; resolve: (value: string | null) => void };

/**
 * Themed, awaitable replacement for `window.confirm` / `window.prompt`.
 * Render `dialog` once; `ask()` resolves true/false and `askText()` resolves
 * the trimmed answer or null. A second ask while one is open resolves as
 * cancelled, so a double tap can't stack dialogs.
 */
export function useConfirm(): {
  ask: (opts: AskOptions) => Promise<boolean>;
  askText: (opts: AskTextOptions) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const open = useRef(false);

  const ask = useCallback((opts: AskOptions) => {
    if (open.current) return Promise.resolve(false);
    open.current = true;
    return new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve }));
  }, []);

  const askText = useCallback((opts: AskTextOptions) => {
    if (open.current) return Promise.resolve(null);
    open.current = true;
    setText("");
    return new Promise<string | null>((resolve) => setPending({ kind: "text", opts, resolve }));
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      if (!pending) return;
      open.current = false;
      setPending(null);
      if (pending.kind === "confirm") pending.resolve(ok);
      else pending.resolve(ok ? text.trim() || null : null);
    },
    [pending, text],
  );

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.opts.title}
      body={pending.opts.body}
      confirmLabel={pending.opts.confirmLabel}
      cancelLabel={pending.opts.cancelLabel}
      tone={pending.opts.tone}
      confirmDisabled={pending.kind === "text" && !text.trim()}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {pending.kind === "text" ? (
        <label className="mt-3 flex flex-col gap-1 text-sm">
          <span className="text-[var(--color-muted)]">{pending.opts.label}</span>
          <input
            autoFocus
            value={text}
            placeholder={pending.opts.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) {
                e.preventDefault();
                settle(true);
              }
            }}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      ) : null}
    </ConfirmDialog>
  ) : null;

  return { ask, askText, dialog };
}

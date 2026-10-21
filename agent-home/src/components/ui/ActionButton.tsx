"use client";

import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  /** The work this button starts. While it runs the button is busy and ignores clicks. */
  onAction?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  /** Busy from outside, e.g. a form's submit or a page refresh still landing. */
  busy?: boolean;
  /** Shown instead of the children while busy, e.g. "Saving…". */
  busyLabel?: ReactNode;
  children: ReactNode;
};

/**
 * The one button for anything that calls the server.
 *
 * From the click until the work finishes it shows a spinner and a busy label,
 * is `disabled`, and drops further clicks (see `useAction` for why `disabled`
 * alone is not enough). Use `busy` for submit buttons whose form runs the
 * action through its own `useAction`.
 */
export function ActionButton({
  onAction,
  busy = false,
  busyLabel,
  disabled,
  children,
  type = "button",
  ...rest
}: Props) {
  const t = useT("common");
  const { run, pending } = useAction(async (event: MouseEvent<HTMLButtonElement>) => {
    await onAction?.(event);
  });
  const working = busy || pending;

  return (
    <button
      data-component="ActionButton"
      {...rest}
      type={type}
      disabled={disabled || working}
      aria-busy={working}
      data-busy={working ? "true" : "false"}
      onClick={
        onAction
          ? (event) => {
              if (working) {
                event.preventDefault();
                return;
              }
              void run(event);
            }
          : undefined
      }
    >
      {working ? (
        <span className="inline-flex items-center justify-center gap-2">
          <Spinner />
          <span>{busyLabel ?? t("working")}</span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}

import type { ReactNode } from "react";

/** Figma `section-header`: small caps label + count, optional trailing link. */
export function SectionHeader({
  id,
  label,
  count,
  attention = false,
  trailing,
}: {
  id: string;
  label: string;
  count: number | null;
  attention?: boolean;
  trailing?: ReactNode;
}) {
  const colour = attention ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]";
  return (
    <div data-component="SectionHeader" className="flex items-center gap-2 px-3 py-1">
      <h2
        id={id}
        className={`text-[11px] font-semibold uppercase leading-[14px] tracking-[0.06em] ${colour}`}
      >
        {label}
      </h2>
      {count !== null ? (
        <span
          data-testid={`${id}-count`}
          aria-live="polite"
          className={`text-[11px] font-semibold leading-[14px] ${colour}`}
        >
          {count}
        </span>
      ) : null}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}

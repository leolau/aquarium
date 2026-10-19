"use client";

import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

const MIN_WIDTH = 72;

/** A fixed-layout table whose columns the user can drag (or arrow-key) wider. */
export function ResizableTable({
  label,
  columns,
  initialWidths,
  children,
}: {
  label: string;
  columns: ReactNode[];
  initialWidths: number[];
  children: ReactNode;
}) {
  const [widths, setWidths] = useState(initialWidths);

  function resize(index: number, next: number) {
    setWidths((current) => {
      const copy = [...current];
      copy[index] = Math.max(MIN_WIDTH, Math.round(next));
      return copy;
    });
  }

  function startDrag(index: number, event: PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widths[index];
    const move = (ev: globalThis.PointerEvent) => resize(index, startWidth + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onKey(index: number, event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "ArrowLeft") resize(index, widths[index] - 16);
    else if (event.key === "ArrowRight") resize(index, widths[index] + 16);
    else return;
    event.preventDefault();
  }

  return (
    <div
      data-component="ResizableTable"
      className="overflow-x-auto rounded-xl border border-[var(--color-border)]"
    >
      <table
        aria-label={label}
        className="table-fixed border-collapse text-sm"
        style={{ width: widths.reduce((sum, w) => sum + w, 0) }}
      >
        <colgroup>
          {widths.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-[var(--color-surface-2,var(--color-surface))] text-left text-xs text-[var(--color-muted)]">
            {columns.map((column, index) => (
              <th key={index} scope="col" className="relative px-3 py-2 font-medium">
                {column}
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize column"
                  aria-valuenow={widths[index]}
                  tabIndex={0}
                  onPointerDown={(event) => startDrag(index, event)}
                  onKeyDown={(event) => onKey(index, event)}
                  className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none border-r border-[var(--color-border)] hover:bg-[var(--color-accent)]/30 focus:bg-[var(--color-accent)]/30 focus:outline-none"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

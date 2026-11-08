/** Shared look for the signed-in edge pages (Not available, Default profile only). */
export const edgeCard =
  "mx-auto flex w-full max-w-[560px] flex-col items-center gap-3 rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center lg:px-10";
const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60";
export const edgePrimary = `${base} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`;
export const edgeSecondary = `${base} border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]`;
export const edgeGhost = `${base} text-[var(--color-text)] hover:bg-[var(--color-surface-2)]`;

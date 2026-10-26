import Link from "next/link";

import type { ProjectLink } from "@/types";
import { newTabRel } from "@/lib/http/link-rel";

const UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
const DIGEST_PREFIX = /^[0-9a-f]{16}-/i;

/**
 * A readable file name from a storage ref's tail
 * (`<user>/<project>/<uuid>-Lesson_Plan.pdf` → `Lesson Plan.pdf`). Uploads
 * slug the original name with `_`, so un-slug it for display.
 */
export function friendlyFileName(ref: string): string | null {
  const tail = ref.split("/").pop() ?? "";
  const name = tail.replace(UUID_PREFIX, "").replace(DIGEST_PREFIX, "");
  if (!name) return null;
  return name.replace(/_/g, " ");
}

/**
 * One pointer row. A link is never an authority (§11 rule 5): until the
 * owning store resolves it under the caller's principal, the row renders
 * greyed from its cached label — no content, no leak.
 */
export function LinkRow({ link }: { link: ProjectLink }) {
  const unresolved = link.resolved === null;
  const label =
    link.label ??
    (link.kind === "file" ? (friendlyFileName(link.ref) ?? link.ref) : link.ref);
  const body = (
    <>
      <span
        className={`block truncate text-sm ${
          unresolved ? "text-[var(--color-muted)]" : ""
        }`}
      >
        {label}
      </span>
      <span className="block text-xs text-[var(--color-muted)]">
        {link.profile}
      </span>
    </>
  );

  const href =
    link.kind === "url"
      ? link.ref
      : link.kind === "arrival"
        ? `/inbox/${encodeURIComponent(link.ref)}`
        : link.kind === "todo"
          ? `/todos/${encodeURIComponent(link.ref)}`
          : null;

  if (link.kind === "url") {
    return (
      <a
        href={link.ref}
        target="_blank"
        rel={newTabRel(link.ref)}
        data-component="LinkRow"
        className="block rounded-lg bg-[var(--color-surface-2)] px-3 py-2"
      >
        {body}
      </a>
    );
  }
  if (href) {
    return (
      <Link
        href={href}
        data-component="LinkRow"
        className="block rounded-lg bg-[var(--color-surface-2)] px-3 py-2"
      >
        {body}
      </Link>
    );
  }
  return (
    <div
      data-component="LinkRow"
      className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2"
    >
      {body}
    </div>
  );
}

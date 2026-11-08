"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import type { Member } from "@/types";

/** Who a removal's owned rows can be handed to: anybody else enrolled there. */
export type RemovalCandidate = Pick<Member, "user_id" | "display">;

/**
 * Removal asks what happens to the rows the user owns, because nothing else
 * will: deleting a principal does not cascade to their memories, files or GTS
 * items, and those rows would survive pointing at an `owner_user_id` that no
 * longer resolves — invisible under C2 and unreachable from any surface.
 */
export function RemoveUserDialog({
  member,
  profile,
  self = false,
  candidates,
  onCancel,
  onConfirm,
}: {
  member: Pick<Member, "user_id" | "display" | "email">;
  /** The profile the enrolment is removed from. */
  profile: string;
  /** The acting person is removing their own enrolment. */
  self?: boolean;
  candidates: RemovalCandidate[];
  onCancel: () => void;
  onConfirm: (strategy: "transfer" | "purge", transferTo: string) => unknown;
}) {
  const [strategy, setStrategy] = useState<"transfer" | "purge">("transfer");
  const [transferTo, setTransferTo] = useState(candidates[0]?.user_id ?? "");
  const name = member.display || member.email || member.user_id;

  return (
    <div
      data-component="RemoveUserDialog"
      className="rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-surface)] p-4"
    >
      <p className="text-sm font-medium">
        {self ? `Remove yourself from ${profile}?` : `Remove ${name} from ${profile}?`}
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {self
          ? "You lose access to this profile until another admin adds you back. "
          : "Their enrolment in this profile goes away. "}
        The box-wide account is kept — it may serve other profiles. Decide what
        happens to the memories, files and GTS items {self ? "you" : "they"} own.
      </p>
      <label className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-[var(--color-muted)]">Owned rows</span>
        <select
          aria-label="Deletion strategy"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as "transfer" | "purge")}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
        >
          <option value="transfer">transfer to somebody</option>
          <option value="purge">purge the private ones</option>
        </select>
      </label>
      {strategy === "transfer" ? (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">Inherited by</span>
          <select
            aria-label="Transfer owned rows to"
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            {candidates.map((c) => (
              <option key={c.user_id} value={c.user_id}>
                {c.display || c.user_id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-3 flex gap-2">
        <ActionButton
          disabled={strategy === "transfer" && !transferTo}
          onAction={() => onConfirm(strategy, strategy === "transfer" ? transferTo : "")}
          className="rounded-lg bg-[var(--color-danger)]/20 px-3 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
        >
          Remove
        </ActionButton>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

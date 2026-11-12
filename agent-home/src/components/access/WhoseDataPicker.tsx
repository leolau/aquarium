"use client";

import { MAX_OWNERS, type ViewablePeople } from "@/lib/whose-data";

/**
 * "Whose data": pick one or more people whose Files, Inbox or memory to show
 * (FG-38 P4). `people` comes from the server with the first page; when it is
 * `null` (only yourself to pick) nothing renders. Choosing is a filter: the
 * server re-checks every read.
 */
export function WhoseDataPicker({
  people,
  value,
  onChange,
}: {
  people: ViewablePeople | null;
  value: string[];
  onChange: (owners: string[]) => void;
}) {
  if (!people) return null;
  const me = people.me;
  const selected = value.length ? value : [me];
  const full = selected.length >= MAX_OWNERS;
  const toggle = (userId: string) => {
    const next = selected.includes(userId)
      ? selected.filter((id) => id !== userId)
      : [...selected, userId];
    onChange(next.length ? next : [me]);
  };

  return (
    <fieldset data-component="WhoseDataPicker" className="flex flex-wrap items-center gap-2 text-sm">
      <legend className="sr-only">Whose data</legend>
      <span aria-hidden className="text-[var(--color-muted)]">Whose data:</span>
      {people.people.map((person) => {
        const on = selected.includes(person.user_id);
        return (
          <label key={person.user_id} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={on}
              disabled={!on && full}
              onChange={() => toggle(person.user_id)}
            />
            {person.user_id === me ? "Me" : person.display}
          </label>
        );
      })}
      {full ? (
        <span className="text-xs text-[var(--color-muted)]">
          Up to {MAX_OWNERS} people at once.
        </span>
      ) : null}
    </fieldset>
  );
}

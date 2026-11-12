"use client";

import { useEffect, useState } from "react";

export type ViewablePerson = { user_id: string; display: string; role: string };
export type ViewablePeople = { me: string; role_reads: boolean; people: ViewablePerson[] };

/**
 * "Whose data": pick one or more people whose Files, Inbox or memory to show
 * (FG-38 P4). Defaults to the signed-in person. Only people the server says
 * the caller may read are offered, and it is hidden when that is only
 * themselves. Choosing is a filter: the server re-checks every read.
 */
export function WhoseDataPicker({
  value,
  onChange,
  onPeople,
}: {
  value: string[];
  onChange: (owners: string[]) => void;
  /** Told who may be picked, once, so rows can say whose they are. */
  onPeople?: (people: ViewablePeople) => void;
}) {
  const [state, setState] = useState<ViewablePeople | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/access/viewable-people", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<ViewablePeople>) : null))
      .then((body) => {
        if (!live || !body || body.people.length < 2) return;
        setState(body);
        onPeople?.(body);
        if (value.length === 0) onChange([body.me]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Loaded once: whose data you may read does not change mid-page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return null;
  const selected = value.length ? value : [state.me];
  const toggle = (userId: string) => {
    const next = selected.includes(userId)
      ? selected.filter((id) => id !== userId)
      : [...selected, userId];
    onChange(next.length ? next : [state.me]);
  };

  return (
    <fieldset data-component="WhoseDataPicker" className="flex flex-wrap items-center gap-2 text-sm">
      <legend className="sr-only">Whose data</legend>
      <span aria-hidden className="text-[var(--color-muted)]">Whose data:</span>
      {state.people.map((person) => (
        <label key={person.user_id} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={selected.includes(person.user_id)}
            onChange={() => toggle(person.user_id)}
          />
          {person.user_id === state.me ? "Me" : person.display}
        </label>
      ))}
    </fieldset>
  );
}

/** The `owners=` value for a picker selection, or `null` to leave it unset. */
export function ownersQuery(owners: string[]): string | null {
  return owners.length ? owners.join(",") : null;
}

/** Whose a row is, for display when the view spans more than the caller. */
export function ownerLabel(
  people: ViewablePeople | null,
  owners: string[],
  ownerUserId: string,
): string | null {
  if (!people || !owners.some((id) => id !== people.me)) return null;
  if (ownerUserId === people.me) return "Me";
  return people.people.find((p) => p.user_id === ownerUserId)?.display ?? ownerUserId;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addCandidates,
  canDelete,
  librarySourceLabel,
  needsCopyChoice,
  profileSkills,
} from "@/components/skills/library";
import { NewSkillModal } from "@/components/skills/NewSkillModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui/Pill";
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import { useAction } from "@/lib/use-action";
import type { SkillCopyChoice, SkillLibrary, SkillLibraryAction, SkillLibraryEntry } from "@/types";

type Confirm =
  | { type: "copy"; skill: SkillLibraryEntry; choice: SkillCopyChoice | null }
  | { type: "delete"; skill: SkillLibraryEntry };

function SourcePill({ skill }: { skill: SkillLibraryEntry }) {
  return <Pill tone={skill.source === "hub" ? "accent" : "muted"}>{librarySourceLabel(skill)}</Pill>;
}

/**
 * Agent Profiles → a profile → Skills: the profile's skills from the box-wide
 * library. Add (from the library), Remove (turn off; the file stays), Create
 * new (saved into this profile) and Delete (only this profile's own skills).
 * Changes apply to the profile's next new chat (prompt caching).
 */
export function ProfileSkillsPanel({ profile, onChanged }: { profile: string; onChanged?(): Promise<void> | void }) {
  const [library, setLibrary] = useState<SkillLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setLibrary(await getJson<SkillLibrary>("/api/skills/library"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    let live = true;
    getJson<SkillLibrary>("/api/skills/library")
      .then((d) => live && setLibrary(d))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  const { on, off } = useMemo(
    () => (library ? profileSkills(library, profile) : { on: [], off: [] }),
    [library, profile],
  );
  const candidates = useMemo(() => {
    if (!library) return [];
    const q = search.trim().toLowerCase();
    return addCandidates(library, profile).filter(
      (s) => !q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q),
    );
  }, [library, profile, search]);
  const categories = useMemo(
    () => [...new Set((library?.skills ?? []).map((s) => s.category).filter(Boolean))].sort(),
    [library],
  );

  async function changeNow(action: SkillLibraryAction, skill: SkillLibraryEntry, where?: SkillCopyChoice) {
    setBusy(skill.name);
    setError(null);
    try {
      await sendJson(`/api/skills/library/${action}`, "POST", {
        target: profile,
        name: skill.name,
        ...(where ? { where } : {}),
      });
      if (action === "add") setJustAdded((s) => new Set(s).add(skill.name));
      const verb =
        action === "add"
          ? where === "shared"
            ? "copied into the shared library and added"
            : where === "only"
              ? `copied into ${profile} only`
              : "added"
          : action === "remove"
            ? "removed (the file stays)"
            : "deleted";
      setStatus(`${skill.name} ${verb}. ${profile}'s next new chat uses it.`);
      await load();
      await onChanged?.();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  // One change at a time: a second click can't send the request again.
  const { run: change, pending } = useAction(changeNow);

  function add(skill: SkillLibraryEntry) {
    if (needsCopyChoice(skill, profile)) {
      setPicking(false);
      setConfirm({ type: "copy", skill, choice: null });
      return;
    }
    setPicking(false);
    void change("add", skill);
  }

  const row = (s: SkillLibraryEntry, enabled: boolean) => (
    <li key={s.name} data-component="ProfileSkillRow" data-skill={s.name} data-state={enabled ? "on" : "off"} className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href="/skills" className={`font-medium hover:text-[var(--color-accent)] ${enabled ? "" : "text-[var(--color-muted)]"}`}>
            {s.name}
          </Link>
          <SourcePill skill={s} />
          {justAdded.has(s.name) && enabled ? <Pill tone="accent">new</Pill> : null}
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-[var(--color-muted)]">{s.description}</p>
      </div>
      {enabled ? (
        <button
          type="button"
          data-action="remove-skill"
          className={secondaryButtonClass}
          title={`Turn off for ${profile} — the file stays`}
          disabled={pending || busy === s.name}
          onClick={() => void change("remove", s)}
        >
          Remove
        </button>
      ) : (
        <button type="button" data-action="readd-skill" className={secondaryButtonClass} disabled={pending || busy === s.name} onClick={() => add(s)}>
          Add back
        </button>
      )}
      {canDelete(s, profile) ? (
        <button
          type="button"
          data-action="delete-skill"
          aria-label={`Delete ${s.name}`}
          className={`${dangerButtonClass} px-3`}
          onClick={() => setConfirm({ type: "delete", skill: s })}
        >
          Delete…
        </button>
      ) : null}
    </li>
  );

  return (
    <div data-component="ProfileSkillsPanel" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-medium">Skills</span>
        <button type="button" data-action="open-skill-picker" className={secondaryButtonClass} disabled={!library} onClick={() => setPicking(true)}>
          + Add from library
        </button>
        <button type="button" data-action="new-skill" className={primaryButtonClass} onClick={() => setCreating(true)}>
          + Create new
        </button>
      </div>
      <p data-testid="profile-skills-summary" className="text-[var(--color-muted)]">
        {library ? `${on.length} on for ${profile}${off.length ? ` · ${off.length} removed` : ""}` : "Loading…"} · from the{" "}
        <Link href="/skills" className="text-[var(--color-accent)] underline">
          Skills library
        </Link>
      </p>

      {/* Slot for the Triage card (status + skills of the user's triage setup). */}
      <div data-slot="profile-skills-triage" />

      {error ? (
        <p role="alert" className="text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-xs text-[var(--color-muted)]">
          {status}
        </p>
      ) : null}

      {library ? (
        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
          {[...on].sort((a, b) => a.name.localeCompare(b.name)).map((s) => row(s, true))}
          {on.length === 0 ? <li className="px-3 py-3 text-[var(--color-muted)]">No skills on for {profile} yet.</li> : null}
        </ul>
      ) : null}
      {off.length ? (
        <details data-testid="profile-skills-removed">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Removed ({off.length}) — files kept, turned off</summary>
          <ul className="mt-1 divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
            {off.map((s) => row(s, false))}
          </ul>
        </details>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">Changes apply to {profile}&apos;s next new chat; running chats keep their skills.</p>

      {picking ? (
        <Sheet component="AddSkillPicker" title={`Add a skill to ${profile}`} onClose={() => setPicking(false)}>
          <div className="space-y-3 text-sm">
            <input
              aria-label="Search the library"
              className={inputClass}
              placeholder="Search the library…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
              {candidates.map((s) => {
                const removed = s.used_by.some((u) => u.profile === profile);
                return (
                  <li key={s.name} data-component="AddSkillOption" data-skill={s.name} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{s.name}</span>
                        <SourcePill skill={s} />
                        {removed ? <Pill>removed</Pill> : null}
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-xs text-[var(--color-muted)]">{s.description}</p>
                    </div>
                    <button type="button" className={secondaryButtonClass} aria-label={`Add ${s.name}`} onClick={() => add(s)}>
                      Add
                    </button>
                  </li>
                );
              })}
              {candidates.length === 0 ? <li className="px-3 py-3 text-[var(--color-muted)]">Nothing else in the library matches.</li> : null}
            </ul>
            <p className="text-xs text-[var(--color-muted)]">
              Triage skills aren&apos;t listed: they belong to the triage pipelines. Not here?{" "}
              <Link href="/skills?view=hub" className="text-[var(--color-accent)] underline">
                Browse the hub
              </Link>{" "}
              or{" "}
              <button
                type="button"
                className="text-[var(--color-accent)] underline"
                onClick={() => {
                  setPicking(false);
                  setCreating(true);
                }}
              >
                create a new skill
              </button>
              .
            </p>
          </div>
        </Sheet>
      ) : null}

      {confirm?.type === "copy" ? (
        <ConfirmDialog
          tone="accent"
          title={`Add ${confirm.skill.name} to ${profile}?`}
          body={`${confirm.skill.name} only exists in profile ${confirm.skill.owners.join(", ")}. Where should ${profile}'s copy come from?`}
          confirmLabel="Add skill"
          busy={pending}
          confirmDisabled={!confirm.choice}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (!confirm.choice) return;
            if (await change("add", confirm.skill, confirm.choice)) setConfirm(null);
          }}
        >
          <div role="radiogroup" aria-label="Where to copy it" className="mt-3 space-y-2 text-sm">
            {(
              [
                ["shared", "Copy into the shared library", `It moves to skills-shared; ${confirm.skill.owners.join(", ")} and ${profile} both use the one copy, and any profile can add it later. Edits apply everywhere.`],
                ["only", `Copy only into ${profile}`, `${profile} gets its own copy. Later edits in ${confirm.skill.owners.join(", ")} won't reach ${profile}, and the other way round.`],
              ] as const
            ).map(([value, title, detail]) => (
              <label
                key={value}
                className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 ${
                  confirm.choice === value ? "border-[var(--color-accent)] bg-[var(--color-surface)]" : "border-[var(--color-border)]"
                }`}
              >
                <input
                  type="radio"
                  name="copy"
                  value={value}
                  checked={confirm.choice === value}
                  onChange={() => setConfirm({ ...confirm, choice: value })}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block font-medium text-[var(--color-fg)]">{title}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{detail}</span>
                </span>
              </label>
            ))}
            <p className="text-xs text-[var(--color-muted)]">You&apos;ll be asked each time you add a skill from another profile.</p>
          </div>
        </ConfirmDialog>
      ) : null}

      {confirm?.type === "delete" ? (
        <ConfirmDialog
          title={`Delete ${confirm.skill.name}?`}
          body={
            confirm.skill.owners.length > 1
              ? `This deletes ${profile}'s copy of the skill's files. Other profiles keep theirs. To stop using it but keep the files, choose Remove instead.`
              : `This deletes the skill's files from profile ${profile}. It's the only copy, so it leaves the library too. To stop using it but keep the files, choose Remove instead.`
          }
          confirmLabel="Delete skill"
          busy={pending}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            if (await change("delete", confirm.skill)) setConfirm(null);
          }}
        />
      ) : null}

      {creating ? (
        <NewSkillModal
          profile={profile}
          categories={categories}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
            await onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

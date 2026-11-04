"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { NewProfileDialog } from "@/components/profiles/NewProfileDialog";
import { ProfileEditor } from "@/components/profiles/ProfileEditor";
import { Pill } from "@/components/ui/Pill";
import { primaryButtonClass } from "@/components/ui/Sheet";
import { errorText, getJson } from "@/lib/admin-fetch";
import type { ModelProviderOption, ProfileInfo } from "@/types";

export interface ProfilesViewProps {
  initialProfiles: ProfileInfo[];
  providers: ModelProviderOption[];
  error: string | null;
}

/** The Profiles page body: card grid, the editor drawer and the new-profile dialog. */
export function ProfilesView({ initialProfiles, providers, error }: ProfilesViewProps) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [loadError, setLoadError] = useState(error);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ from?: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await getJson<{ profiles: ProfileInfo[] }>("/api/profiles");
      setProfiles(data.profiles);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  const current = profiles.find((p) => p.name === editing) ?? null;

  return (
    <section data-component="ProfilesView" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">
          {profiles.length} {profiles.length === 1 ? "profile" : "profiles"} · each is its own
          agent: soul, model, skills, memory, credentials
        </p>
        <button
          type="button"
          data-testid="new-profile"
          className={primaryButtonClass}
          onClick={() => setCreating({})}
        >
          + New profile
        </button>
      </div>

      {loadError ? (
        <p
          data-component="ProfilesError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load profiles ({loadError}).
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {profiles.map((p) => (
          <li key={p.name}>
            <button
              type="button"
              data-component="ProfileCard"
              data-profile={p.name}
              onClick={() => setEditing(p.name)}
              className="h-full w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left hover:border-[var(--color-accent)]"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                {p.is_default ? <Pill tone="accent">default</Pill> : null}
              </div>
              <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-[var(--color-muted)]">
                {p.description || "No description yet."}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.description_auto ? <Pill>auto description</Pill> : null}
                <Pill>{p.model || "no model set"}</Pill>
                <Pill>
                  {p.skill_count} {p.skill_count === 1 ? "skill" : "skills"}
                </Pill>
                <Pill tone={p.gateway_running ? "success" : "muted"}>
                  gateway {p.gateway_running ? "running" : "off"}
                </Pill>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-sm text-[var(--color-muted)]">
        Tap a profile to edit it. Pending{" "}
        <Link href="/profiles/suggestions" className="text-[var(--color-accent)] underline">
          Profile suggestions
        </Link>{" "}
        stay on their own page; adopting one adds a card here.
      </p>

      {current ? (
        <ProfileEditor
          profile={current}
          providers={providers}
          onClose={() => setEditing(null)}
          onChanged={reload}
          onRenamed={async (name) => {
            await reload();
            setEditing(name);
          }}
          onDeleted={async () => {
            setEditing(null);
            await reload();
          }}
          onDuplicate={() => {
            setEditing(null);
            setCreating({ from: current.name });
          }}
        />
      ) : null}

      {creating ? (
        <NewProfileDialog
          profiles={profiles}
          providers={providers}
          initialSource={creating.from}
          onClose={() => setCreating(null)}
          onCreated={async () => {
            setCreating(null);
            await reload();
          }}
        />
      ) : null}
    </section>
  );
}

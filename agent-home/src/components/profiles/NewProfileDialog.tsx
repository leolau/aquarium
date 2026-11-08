"use client";

import { useEffect, useMemo, useState } from "react";

import { modelChoices } from "@/components/profiles/model-choices";
import { ActionButton } from "@/components/ui/ActionButton";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import type {
  ModelProviderOption,
  ProfileCreateInput,
  ProfileCreateResult,
  ProfileInfo,
  SkillHubResult,
  SkillHubSearchResponse,
  SkillInfo,
} from "@/types";

export type StartFrom = "blank" | "copy" | "all";

const STEPS = ["Identity", "Model", "Skills", "Review"] as const;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface NewProfileDialogProps {
  profiles: ProfileInfo[];
  providers: ModelProviderOption[];
  /** Pre-select "copy settings, soul and skills of" this profile (Duplicate). */
  initialSource?: string;
  onClose(): void;
  onCreated(result: ProfileCreateResult): Promise<void>;
}

/**
 * Build the single `POST /api/profiles` body from the dialog's answers.
 * `keep_skills` is only sent when some skill was unticked: the backend reads
 * a non-empty list as "disable everything else", an empty one as "keep all".
 */
export function buildProfileCreate(input: {
  name: string;
  description: string;
  startFrom: StartFrom;
  source: string;
  provider: string;
  model: string;
  available: string[];
  kept: Set<string>;
  hubSkills: string[];
}): ProfileCreateInput {
  const allKept = input.available.every((s) => input.kept.has(s));
  return {
    name: input.name.trim(),
    description: input.description.trim() || undefined,
    clone_from: input.startFrom === "blank" ? null : input.source,
    clone_all: input.startFrom === "all",
    provider: input.provider || undefined,
    model: input.model || undefined,
    keep_skills: allKept ? [] : input.available.filter((s) => input.kept.has(s)),
    hub_skills: input.hubSkills,
  };
}

/** The stepped "+ New profile" dialog. Nothing is written until Create. */
export function NewProfileDialog({
  profiles,
  providers,
  initialSource,
  onClose,
  onCreated,
}: NewProfileDialogProps) {
  const fallbackSource = profiles.find((p) => p.is_default)?.name ?? profiles[0]?.name ?? "default";
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initialSource ? `${initialSource}-copy` : "");
  const [description, setDescription] = useState("");
  const [startFrom, setStartFrom] = useState<StartFrom>(initialSource ? "copy" : "blank");
  const [source, setSource] = useState(initialSource ?? fallbackSource);
  const [model, setModel] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; list: SkillInfo[] } | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [hubQuery, setHubQuery] = useState("");
  const [hubResults, setHubResults] = useState<SkillHubResult[]>([]);
  const [hubSkills, setHubSkills] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(() => modelChoices(providers), [providers]);
  const skillSource = startFrom === "blank" ? fallbackSource : source;

  const skillKey = `${startFrom === "blank" ? "blank" : "copy"}:${skillSource}`;
  const skills = loaded?.key === skillKey ? loaded.list : null;

  useEffect(() => {
    let live = true;
    const q = profileQuery(skillSource);
    getJson<SkillInfo[]>(`/api/skills${q ? `?${q}` : ""}`)
      .then((list) => {
        if (!live) return;
        // A blank profile is seeded with the bundled skills only.
        const pool = startFrom === "blank" ? list.filter((s) => s.source === "builtin") : list;
        setLoaded({ key: skillKey, list: pool });
        setKept(new Set(pool.filter((s) => s.enabled).map((s) => s.name)));
      })
      .catch(() => live && setLoaded({ key: skillKey, list: [] }));
    return () => {
      live = false;
    };
  }, [skillKey, skillSource, startFrom]);

  const nameTaken = profiles.some((p) => p.name === name.trim());
  const nameOk = NAME_RE.test(name.trim()) && !nameTaken;
  const chosen = choices.find((c) => c.value === model);
  const available = (skills ?? []).map((s) => s.name);
  const visible = (skills ?? []).filter(
    (s) => !filter || `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(filter.toLowerCase()),
  );

  async function searchHub() {
    setError(null);
    try {
      const res = await getJson<SkillHubSearchResponse>(
        `/api/skills/hub/search?q=${encodeURIComponent(hubQuery.trim())}`,
      );
      setHubResults(res.results);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function create() {
    setError(null);
    try {
      const body = buildProfileCreate({
        name,
        description,
        startFrom,
        source,
        provider: chosen?.provider ?? "",
        model: chosen?.model ?? "",
        available,
        kept,
        hubSkills,
      });
      const res = await sendJson<ProfileCreateResult>("/api/profiles", "POST", body);
      await onCreated(res);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const startLabel =
    startFrom === "blank"
      ? "Blank (built-in skills only)"
      : startFrom === "copy"
        ? `Copy settings, soul and skills of ${source}`
        : `Copy everything from ${source} (incl. memory)`;

  return (
    <Sheet
      component="NewProfileDialog"
      title="New profile"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 text-xs text-[var(--color-muted)]">
            Nothing is written until &ldquo;Create profile&rdquo; on the Review step.
          </span>
          {step === 0 ? (
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Cancel
            </button>
          ) : (
            <button type="button" className={secondaryButtonClass} onClick={() => setStep(step - 1)}>
              ← Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={step === 0 && !nameOk}
              onClick={() => setStep(step + 1)}
            >
              Next →
            </button>
          ) : (
            <ActionButton className={primaryButtonClass} busyLabel="Creating…" onAction={create}>
              Create profile
            </ActionButton>
          )}
        </>
      }
    >
      <ol className="mb-4 flex flex-wrap gap-2 text-xs" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            className={`rounded-full px-3 py-1 ${
              i === step
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="space-y-4 text-sm">
        {step === 0 ? (
          <>
            <label className="block space-y-1">
              <span className="font-medium">Name (lowercase, letters, digits, -)</span>
              <input
                className={inputClass}
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="research-helper"
              />
              {name && !nameOk ? (
                <span className="text-xs text-[var(--color-danger)]">
                  {nameTaken ? "That name is taken." : "Use lowercase letters, digits, - or _."}
                </span>
              ) : null}
            </label>
            <label className="block space-y-1">
              <span className="font-medium">What is it for?</span>
              <textarea
                className={`${inputClass} min-h-[4rem]`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="font-medium">Start from</legend>
              {(["blank", "copy", "all"] as const).map((opt) => (
                <label key={opt} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="start-from"
                    checked={startFrom === opt}
                    onChange={() => setStartFrom(opt)}
                  />
                  <span>
                    {opt === "blank"
                      ? "Blank (built-in skills only)"
                      : opt === "copy"
                        ? "Copy settings, soul and skills of:"
                        : "Copy everything from (incl. memory):"}
                  </span>
                </label>
              ))}
              {startFrom !== "blank" ? (
                <select
                  aria-label="Source profile"
                  className={inputClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </fieldset>
          </>
        ) : null}

        {step === 1 ? (
          <label className="block space-y-1">
            <span className="font-medium">Model</span>
            <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">
                {startFrom === "blank" ? "Box default" : `Keep ${source}'s model`}
              </option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {step === 2 ? (
          <>
            <input
              aria-label="Filter skills"
              className={inputClass}
              placeholder="Filter skills…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {skills === null ? (
              <p className="text-[var(--color-muted)]">Loading skills…</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {visible.map((s) => (
                  <li key={s.name}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={kept.has(s.name)}
                        onChange={(e) => {
                          const next = new Set(kept);
                          if (e.target.checked) next.add(s.name);
                          else next.delete(s.name);
                          setKept(next);
                        }}
                      />
                      <span className="font-medium">{s.name}</span>
                      <span className="truncate text-xs text-[var(--color-muted)]">{s.category}</span>
                    </label>
                  </li>
                ))}
                {visible.length === 0 ? (
                  <li className="text-[var(--color-muted)]">No skills match.</li>
                ) : null}
              </ul>
            )}
            <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
              <span className="font-medium">+ add from hub</span>
              <div className="flex gap-2">
                <input
                  aria-label="Search the skills hub"
                  className={inputClass}
                  value={hubQuery}
                  placeholder="Search the hub…"
                  onChange={(e) => setHubQuery(e.target.value)}
                />
                <ActionButton
                  className={secondaryButtonClass}
                  disabled={!hubQuery.trim()}
                  busyLabel="Searching…"
                  onAction={searchHub}
                >
                  Search
                </ActionButton>
              </div>
              {hubSkills.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {hubSkills.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-xs"
                      onClick={() => setHubSkills(hubSkills.filter((h) => h !== id))}
                      aria-label={`Remove ${id}`}
                    >
                      {id} ✕
                    </button>
                  ))}
                </div>
              ) : null}
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {hubResults.map((r) => (
                  <li key={r.identifier} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {r.name}{" "}
                      <span className="text-xs text-[var(--color-muted)]">{r.trust_level}</span>
                    </span>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={hubSkills.includes(r.identifier)}
                      onClick={() => setHubSkills([...hubSkills, r.identifier])}
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-[var(--color-muted)]">
                Hub skills are security-scanned when they install; dangerous ones are refused.
              </p>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <dl data-testid="new-profile-review" className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2">
            <dt className="text-[var(--color-muted)]">Name</dt>
            <dd>{name.trim()}</dd>
            <dt className="text-[var(--color-muted)]">For</dt>
            <dd>{description.trim() || "—"}</dd>
            <dt className="text-[var(--color-muted)]">Start from</dt>
            <dd>{startLabel}</dd>
            <dt className="text-[var(--color-muted)]">Model</dt>
            <dd>{chosen?.label ?? (startFrom === "blank" ? "Box default" : `Same as ${source}`)}</dd>
            <dt className="text-[var(--color-muted)]">Skills</dt>
            <dd>
              {kept.size} of {available.length} kept
              {hubSkills.length ? ` · +${hubSkills.length} from hub` : ""}
            </dd>
          </dl>
        ) : null}

        {error ? (
          <p role="alert" className="text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

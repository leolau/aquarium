"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { choiceValue, modelChoices } from "@/components/profiles/model-choices";
import { ActionButton } from "@/components/ui/ActionButton";
import {
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  Sheet,
} from "@/components/ui/Sheet";
import { errorText, getJson, profilePath, profileQuery, sendJson } from "@/lib/admin-fetch";
import type { ModelProviderOption, ProfileDescribeResult, ProfileInfo, SkillInfo } from "@/types";

export interface ProfileEditorProps {
  profile: ProfileInfo;
  providers: ModelProviderOption[];
  onClose(): void;
  onChanged(): Promise<void>;
  onRenamed(name: string): Promise<void>;
  onDeleted(): Promise<void>;
  onDuplicate(): void;
}

type Mode = "edit" | "rename" | "delete";

/** The drawer behind a profile card: description, model, SOUL.md, skills, status. */
export function ProfileEditor({
  profile,
  providers,
  onClose,
  onChanged,
  onRenamed,
  onDeleted,
  onDuplicate,
}: ProfileEditorProps) {
  const [description, setDescription] = useState(profile.description);
  const [model, setModel] = useState(choiceValue(profile.provider, profile.model));
  const [soul, setSoul] = useState<string | null>(null);
  const [savedSoul, setSavedSoul] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [newName, setNewName] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const choices = useMemo(
    () => modelChoices(providers, { provider: profile.provider, model: profile.model }),
    [providers, profile.provider, profile.model],
  );

  useEffect(() => {
    let live = true;
    getJson<{ content: string }>(profilePath(profile.name, "soul"))
      .then((d) => {
        if (!live) return;
        setSoul(d.content);
        setSavedSoul(d.content);
      })
      .catch(() => live && setSoul(""));
    const q = profileQuery(profile.name);
    getJson<SkillInfo[]>(`/api/skills${q ? `?${q}` : ""}`)
      .then((d) => live && setSkills(d))
      .catch(() => live && setSkills(null));
    return () => {
      live = false;
    };
  }, [profile.name]);

  async function save() {
    setMessage(null);
    try {
      if (description !== profile.description) {
        await sendJson(profilePath(profile.name, "description"), "PUT", { description });
      }
      const original = choiceValue(profile.provider, profile.model);
      if (model && model !== original) {
        const choice = choices.find((c) => c.value === model);
        if (choice) {
          await sendJson(profilePath(profile.name, "model"), "PUT", {
            provider: choice.provider,
            model: choice.model,
          });
        }
      }
      if (soul !== null && soul !== savedSoul) {
        await sendJson(profilePath(profile.name, "soul"), "PUT", { content: soul });
        setSavedSoul(soul);
      }
      await onChanged();
      setMessage({ tone: "ok", text: "Saved. New chats with this profile use the changes." });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  async function autoWrite() {
    setMessage(null);
    try {
      const res = await sendJson<ProfileDescribeResult>(
        profilePath(profile.name, "describe-auto"),
        "POST",
        { overwrite: true },
      );
      if (res.ok && res.description) {
        setDescription(res.description);
        await onChanged();
      } else {
        setMessage({ tone: "error", text: res.reason || "Couldn't write a description." });
      }
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  async function rename() {
    setMessage(null);
    try {
      const res = await sendJson<{ name?: string }>(profilePath(profile.name), "PATCH", {
        new_name: newName.trim(),
      });
      setMode("edit");
      await onRenamed(res.name ?? newName.trim());
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  async function remove() {
    setMessage(null);
    try {
      await sendJson(profilePath(profile.name), "DELETE");
      await onDeleted();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }

  const enabled = skills?.filter((s) => s.enabled).length;
  const q = profileQuery(profile.name);

  const footer =
    mode === "rename" ? (
      <>
        <input
          aria-label="New name"
          className={`${inputClass} min-w-0 flex-1`}
          value={newName}
          placeholder="new-name"
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="button" className={secondaryButtonClass} onClick={() => setMode("edit")}>
          Cancel
        </button>
        <ActionButton
          className={primaryButtonClass}
          disabled={!newName.trim() || newName.trim() === profile.name}
          busyLabel="Renaming…"
          onAction={rename}
        >
          Rename
        </ActionButton>
      </>
    ) : mode === "delete" ? (
      <>
        <p className="w-full text-xs text-[var(--color-muted)]">
          This deletes the profile with its memory, sessions and credentials. Type{" "}
          <strong>{profile.name}</strong> to confirm.
        </p>
        <input
          aria-label="Type the profile name to confirm"
          className={`${inputClass} min-w-0 flex-1`}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <button type="button" className={secondaryButtonClass} onClick={() => setMode("edit")}>
          Cancel
        </button>
        <ActionButton
          className={dangerButtonClass}
          disabled={confirmName !== profile.name}
          busyLabel="Deleting…"
          onAction={remove}
        >
          Delete profile
        </ActionButton>
      </>
    ) : (
      <>
        <ActionButton className={primaryButtonClass} busyLabel="Saving…" onAction={save}>
          Save
        </ActionButton>
        <button type="button" className={secondaryButtonClass} onClick={onDuplicate}>
          Duplicate…
        </button>
        {profile.is_default ? null : (
          <>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setNewName(profile.name);
                setMode("rename");
              }}
            >
              Rename…
            </button>
            <button
              type="button"
              className={dangerButtonClass}
              onClick={() => {
                setConfirmName("");
                setMode("delete");
              }}
            >
              Delete…
            </button>
          </>
        )}
      </>
    );

  return (
    <Sheet
      component="ProfileEditor"
      side
      title={
        <span className="flex items-center gap-2">
          {profile.name}
          {profile.is_default ? (
            <span className="rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-xs font-normal text-[var(--color-accent-fg)]">
              default
            </span>
          ) : null}
        </span>
      }
      onClose={onClose}
      footer={footer}
    >
      <div className="space-y-4 text-sm">
        <label className="block space-y-1">
          <span className="flex items-center gap-2 font-medium">
            <span className="flex-1">Description</span>
            <ActionButton className={secondaryButtonClass} busyLabel="Writing…" onAction={autoWrite}>
              Auto-write
            </ActionButton>
          </span>
          <textarea
            className={`${inputClass} min-h-[4rem]`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="font-medium">Model</span>
          <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
            {model === "" ? <option value="">Not set</option> : null}
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="font-medium">Soul (SOUL.md)</span>
          <span className="block text-xs text-[var(--color-muted)]">
            Personality and standing instructions
          </span>
          <textarea
            aria-label="SOUL.md"
            className={`${inputClass} min-h-[8rem] font-mono text-xs`}
            value={soul ?? ""}
            disabled={soul === null}
            placeholder={soul === null ? "Loading…" : ""}
            onChange={(e) => setSoul(e.target.value)}
          />
        </label>

        <div className="space-y-1">
          <span className="font-medium">Skills</span>
          <p data-testid="profile-skills-summary" className="text-[var(--color-muted)]">
            {profile.skill_count} installed
            {enabled !== undefined ? ` · ${enabled} enabled` : ""}
          </p>
          <Link
            href={`/skills${q ? `?${q}` : ""}`}
            className="text-[var(--color-accent)] underline"
          >
            Manage skills →
          </Link>
        </div>

        <div className="space-y-1">
          <span className="font-medium">Status</span>
          <p className="text-[var(--color-muted)]">
            Gateway: {profile.gateway_running ? "running" : "off"} · Credentials file:{" "}
            {profile.has_env ? "present" : "none"} · Path: hidden for safety
          </p>
        </div>

        {profile.is_default ? (
          <p className="text-xs text-[var(--color-muted)]">
            The default profile can&apos;t be renamed or deleted.
          </p>
        ) : null}

        {message ? (
          <p
            role={message.tone === "error" ? "alert" : "status"}
            className={message.tone === "error" ? "text-[var(--color-danger)]" : "text-emerald-300"}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

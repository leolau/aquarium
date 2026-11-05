"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { dangerButtonClass, inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import type { SkillInfo } from "@/types";

/** Edit a skill's SKILL.md. Hub-installed skills can also be uninstalled. */
export function SkillEditorModal({
  skill,
  profile,
  onClose,
  onChanged,
}: {
  skill: SkillInfo;
  profile: string;
  onClose(): void;
  onChanged(): Promise<void>;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const q = profileQuery(profile);
  const scoped = q ? { profile } : {};

  useEffect(() => {
    let live = true;
    getJson<{ content: string }>(`/api/skills/content?name=${encodeURIComponent(skill.name)}${q ? `&${q}` : ""}`)
      .then((d) => live && setContent(d.content))
      .catch((err) => {
        if (!live) return;
        setContent("");
        setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [skill.name, q]);

  async function save() {
    setError(null);
    try {
      await sendJson("/api/skills/content", "PUT", { name: skill.name, content, ...scoped });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function uninstall() {
    setError(null);
    try {
      await sendJson("/api/skills/hub/uninstall", "POST", { name: skill.name, ...scoped });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Sheet
      component="SkillEditorModal"
      title={`Edit SKILL.md · ${skill.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          {skill.source === "hub" ? (
            confirmUninstall ? (
              <ActionButton className={dangerButtonClass} busyLabel="Uninstalling…" onAction={uninstall}>
                Really uninstall
              </ActionButton>
            ) : (
              <button type="button" className={dangerButtonClass} onClick={() => setConfirmUninstall(true)}>
                Uninstall
              </button>
            )
          ) : null}
          <span className="flex-1" />
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
          <ActionButton
            className={primaryButtonClass}
            disabled={content === null || !content.trim()}
            busyLabel="Saving…"
            onAction={save}
          >
            Save
          </ActionButton>
        </>
      }
    >
      <textarea
        aria-label="SKILL.md"
        className={`${inputClass} min-h-[50vh] font-mono text-xs`}
        value={content ?? ""}
        disabled={content === null}
        placeholder={content === null ? "Loading…" : ""}
        onChange={(e) => setContent(e.target.value)}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}

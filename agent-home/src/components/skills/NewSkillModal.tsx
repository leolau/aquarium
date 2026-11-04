"use client";

import { useState } from "react";

import { skillTemplate } from "@/components/skills/skill-filters";
import { ActionButton } from "@/components/ui/ActionButton";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, profileQuery, sendJson } from "@/lib/admin-fetch";

const NEW_CATEGORY = "__new__";

/** "+ New skill": name, category, optional description/sources, SKILL.md. */
export function NewSkillModal({
  profile,
  categories,
  onClose,
  onCreated,
}: {
  profile: string;
  categories: string[];
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(categories[0] ?? NEW_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [description, setDescription] = useState("");
  const [sources, setSources] = useState("");
  const [content, setContent] = useState(skillTemplate("", "", ""));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh(next: { name?: string; description?: string; sources?: string }) {
    if (touched) return;
    setContent(skillTemplate(next.name ?? name, next.description ?? description, next.sources ?? sources));
  }

  async function create() {
    setError(null);
    try {
      const chosen = category === NEW_CATEGORY ? newCategory.trim() : category;
      await sendJson("/api/skills", "POST", {
        name: name.trim(),
        content,
        category: chosen || undefined,
        ...(profileQuery(profile) ? { profile } : {}),
      });
      await onCreated();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Sheet
      component="NewSkillModal"
      title={`New skill · ${profile}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
          <ActionButton
            className={primaryButtonClass}
            disabled={!name.trim() || !content.trim()}
            busyLabel="Creating…"
            onAction={create}
          >
            Create skill
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="font-medium">Name</span>
            <input
              className={inputClass}
              value={name}
              placeholder="expense-report"
              onChange={(e) => {
                setName(e.target.value);
                refresh({ name: e.target.value });
              }}
            />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">Category</span>
            <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={NEW_CATEGORY}>(new category…)</option>
            </select>
            {category === NEW_CATEGORY ? (
              <input
                aria-label="New category"
                className={inputClass}
                value={newCategory}
                placeholder="productivity"
                onChange={(e) => setNewCategory(e.target.value)}
              />
            ) : null}
          </label>
        </div>
        <label className="block space-y-1">
          <span className="font-medium">Description (optional)</span>
          <textarea
            className={`${inputClass} min-h-[3rem]`}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              refresh({ description: e.target.value });
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">Sources (optional, one per line)</span>
          <textarea
            className={`${inputClass} min-h-[3rem]`}
            value={sources}
            placeholder="https://…"
            onChange={(e) => {
              setSources(e.target.value);
              refresh({ sources: e.target.value });
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">SKILL.md</span>
          <textarea
            aria-label="SKILL.md"
            className={`${inputClass} min-h-[14rem] font-mono text-xs`}
            value={content}
            onChange={(e) => {
              setTouched(true);
              setContent(e.target.value);
            }}
          />
        </label>
        <p className="text-xs text-[var(--color-muted)]">New skills are available to new chats.</p>
        {error ? (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChipInput } from "@/components/skills/ChipInput";
import { CodeEditor } from "@/components/skills/CodeEditor";
import { CopyButton, downloadText } from "@/components/skills/CopyButton";
import { SkillMarkdown } from "@/components/skills/SkillMarkdown";
import { skillHref } from "@/components/skills/skill-links";
import { ActionButton } from "@/components/ui/ActionButton";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/useConfirm";
import { errorText, profileQuery, sendJson } from "@/lib/admin-fetch";
import { changedLineCount, diffLines, hunks } from "@/lib/skills/diff";
import { applyEdit, byteLength, formatSize, lineCount, type SkillEdit } from "@/lib/skills/editor-state";
import { applyFormat, type FormatKind } from "@/lib/skills/format";
import { getBody, parseSkill, type MetaField } from "@/lib/skills/frontmatter";
import { hasErrors, MAX_DESCRIPTION_LENGTH, validateSkill, type Check } from "@/lib/skills/validate";
import type { SkillInfo } from "@/types";

export type EditorView = "structured" | "plain";

const PLATFORMS = ["linux", "macos", "windows"];

const TOOLBAR: Array<{ kind: FormatKind; label: ReactNode; title: string }> = [
  { kind: "heading", label: "H", title: "Heading" },
  { kind: "bold", label: <b>B</b>, title: "Bold" },
  { kind: "italic", label: <i>I</i>, title: "Italic" },
  { kind: "code", label: "</>", title: "Code" },
  { kind: "codeblock", label: "{ }", title: "Code block" },
  { kind: "list", label: "• list", title: "List" },
  { kind: "numbered", label: "1. list", title: "Numbered list" },
  { kind: "link", label: "Link", title: "Link" },
  { kind: "table", label: "▦", title: "Table" },
];

const paneClass = "flex min-h-[520px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]";
const barClass = "flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5";
const barButton = "!min-h-8 rounded-md border border-transparent px-2 text-xs hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]";
const labelClass = "mb-1 mt-2.5 block text-xs text-[var(--color-muted)]";

function Segmented<T extends string>({ value, options, onChange, label, className = "" }: { value: T; options: Array<[T, string]>; onChange(v: T): void; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`inline-flex overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`!min-h-9 px-3.5 text-[13px] ${value === v ? "bg-[var(--color-accent)] font-semibold text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function ValidationBar({ checks, doc }: { checks: Check[]; doc: string }) {
  return (
    <div data-component="SkillValidation" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs">
      {checks.map((c, k) => (
        <span key={k} data-level={c.level} className={c.level === "ok" ? "text-emerald-400" : c.level === "warn" ? "text-[var(--color-warn-text)]" : "text-[var(--color-danger)]"}>
          {c.level === "ok" ? "✓" : c.level === "warn" ? "⚠" : "✕"} {c.text}
        </span>
      ))}
      <span className="flex-1" />
      <span className="text-[var(--color-muted)]">
        {lineCount(doc)} lines · {formatSize(byteLength(doc))}
      </span>
    </div>
  );
}

/** Edit one skill's SKILL.md as a form + Markdown editor, or as the whole file. */
export function SkillEditor({
  name,
  profile,
  content,
  skill,
  installed,
  categories,
  initialView = "structured",
}: {
  name: string;
  profile: string;
  content: string;
  skill: SkillInfo | null;
  installed: string[];
  categories: string[];
  initialView?: EditorView;
}) {
  const router = useRouter();
  const [original, setOriginal] = useState(content);
  const [doc, setDoc] = useState(content);
  const [view, setView] = useState<EditorView>(initialView);
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const [fullscreen, setFullscreen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirty = doc !== original;
  const leaving = useRef(false);
  const { ask: askConfirm, dialog: leaveDialog } = useConfirm();
  const q = profileQuery(profile);
  const viewHref = skillHref(name, profile);

  const parsed = useMemo(() => parseSkill(doc), [doc]);
  const body = useMemo(() => getBody(doc), [doc]);
  const previewBody = useDeferredValue(body);
  const checks = useMemo(() => validateSkill(doc, name), [doc, name]);
  const ops = useMemo(() => (dirty ? diffLines(original, doc) : []), [dirty, original, doc]);
  const changed = useMemo(() => changedLineCount(ops), [ops]);
  const { meta, unsupported } = parsed;
  const locked = (f: MetaField) => !parsed.split.hasFrontmatter || unsupported.includes(f);

  function edit(e: SkillEdit) {
    const res = applyEdit(doc, e);
    setFieldError(res.error);
    setDoc(res.doc);
  }

  // Warn before a reload/close or an in-app link would drop unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      void askConfirm({
        title: "Leave without saving?",
        body: "You have unsaved changes to this skill.",
        confirmLabel: "Leave",
      }).then((leave) => {
        if (!leave) return;
        leaving.current = true;
        (a as HTMLAnchorElement).click();
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, askConfirm]);

  useEffect(() => {
    if (!fullscreen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [fullscreen]);

  function format(kind: FormatKind) {
    const ta = bodyRef.current;
    const start = ta?.selectionStart ?? body.length;
    const end = ta?.selectionEnd ?? body.length;
    const next = applyFormat(body, start, end, kind);
    edit({ kind: "body", body: next.text });
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(next.start, next.end);
    });
  }

  async function save() {
    setSaveError(null);
    try {
      await sendJson("/api/skills/content", "PUT", { name, content: doc, ...(q ? { profile } : {}) });
      leaving.current = true;
      setOriginal(doc);
      setReviewing(false);
      router.push(viewHref);
      router.refresh();
    } catch (err) {
      setSaveError(errorText(err));
    }
  }

  function discard() {
    leaving.current = true;
    setDoc(original);
    router.push(viewHref);
  }

  const builtinNote =
    skill?.source === "builtin" ? (
      <>
        Built-in skill: saving edits profile {profile}&apos;s copy, and Hermes updates stop replacing it. To go back to
        the shipped version run <code className="font-mono">hermes skills reset {name} --restore</code>.
      </>
    ) : null;

  const categoryOptions = Array.from(new Set([...categories, meta.category].filter(Boolean))).sort();
  const platformOptions = Array.from(new Set([...PLATFORMS, ...meta.platforms]));
  const fullscreenWrap = fullscreen ? "fixed inset-0 z-50 !min-h-0 rounded-none bg-[var(--color-surface)]" : "";
  const fsButton = (
    <button type="button" className={barButton} aria-pressed={fullscreen} onClick={() => setFullscreen((f) => !f)}>
      {fullscreen ? "Exit full screen" : "⤢ Full screen"}
    </button>
  );

  return (
    <section data-component="SkillEditor" data-skill={name} data-view={view} className="space-y-3.5 pb-2">
      {leaveDialog}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 text-[13px] text-[var(--color-muted)]">
          <Link href={viewHref} className="text-[var(--color-accent)]">
            ‹ {name}
          </Link>{" "}
          · editing in profile <b className="text-[var(--color-fg)]">{profile}</b>
        </div>
        <span className="text-xs text-[var(--color-muted)]">View</span>
        <Segmented<EditorView>
          label="Editor view"
          value={view}
          onChange={(v) => {
            setView(v);
            setFullscreen(false);
          }}
          options={[
            ["structured", "Structured"],
            ["plain", "Plain text"],
          ]}
        />
      </div>

      {view === "structured" ? (
        <>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-base font-semibold">Details</h2>
              <span className="flex-1" />
              {builtinNote ? <span className="text-xs text-[var(--color-muted)]">{builtinNote}</span> : null}
            </div>
            {!parsed.split.hasFrontmatter ? (
              <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                The YAML header can&apos;t be read, so the form is off. Fix it in Plain text.
              </p>
            ) : unsupported.length ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                {unsupported.join(", ")} {unsupported.length === 1 ? "is" : "are"} written in a form only Plain text can change.
              </p>
            ) : null}
            {fieldError ? (
              <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                {fieldError}
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-x-3.5 md:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="skill-name">Name</label>
                <input id="skill-name" className={`${inputClass} opacity-70`} value={meta.name || name} disabled readOnly />
              </div>
              <div>
                <label className={labelClass} htmlFor="skill-version">Version</label>
                <input
                  id="skill-version"
                  className={inputClass}
                  value={meta.version}
                  disabled={locked("version")}
                  placeholder="1.0.0"
                  onChange={(e) => edit({ kind: "field", field: "version", value: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className={labelClass} htmlFor="skill-description">
                  Description — when should the agent use this skill?{" "}
                  <span className={meta.description.length > MAX_DESCRIPTION_LENGTH ? "text-[var(--color-danger)]" : ""}>
                    ({meta.description.length} / {MAX_DESCRIPTION_LENGTH})
                  </span>
                </label>
                <input
                  id="skill-description"
                  className={inputClass}
                  value={meta.description}
                  disabled={locked("description")}
                  onChange={(e) => edit({ kind: "field", field: "description", value: e.target.value })}
                />
              </div>
              <div>
                <span className={labelClass}>Tags</span>
                <ChipInput label="Add tag" placeholder="add tag…" values={meta.tags} disabled={locked("tags")} onChange={(v) => edit({ kind: "field", field: "tags", value: v })} />
              </div>
              <div>
                <span className={labelClass}>Related skills</span>
                <ChipInput
                  label="Add related skill"
                  placeholder="search skills…"
                  values={meta.related_skills}
                  suggestions={installed.filter((s) => s !== name)}
                  disabled={locked("related_skills")}
                  onChange={(v) => edit({ kind: "field", field: "related_skills", value: v })}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="skill-category">Category</label>
                <select
                  id="skill-category"
                  className={inputClass}
                  value={meta.category}
                  disabled={locked("category")}
                  onChange={(e) => edit({ kind: "field", field: "category", value: e.target.value })}
                >
                  <option value="">(none)</option>
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset disabled={locked("platforms")}>
                <legend className={labelClass}>Platforms <span className="opacity-80">(none ticked = all)</span></legend>
                <div className="flex flex-wrap gap-x-4 text-sm">
                  {platformOptions.map((p) => (
                    <label key={p} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-accent)]"
                        checked={meta.platforms.includes(p)}
                        onChange={(e) =>
                          edit({
                            kind: "field",
                            field: "platforms",
                            value: e.target.checked ? [...meta.platforms, p] : meta.platforms.filter((x) => x !== p),
                          })
                        }
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>

          <Segmented<"edit" | "preview">
            label="Show"
            className="lg:hidden"
            value={pane}
            onChange={setPane}
            options={[
              ["edit", "Edit"],
              ["preview", "Preview"],
            ]}
          />
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            <div className={`${paneClass} ${fullscreenWrap} ${pane === "edit" ? "" : "hidden lg:flex"}`}>
              <div role="toolbar" aria-label="Formatting" className={barClass}>
                <b className="mr-1.5 text-xs">Instructions</b>
                {TOOLBAR.map((t) => (
                  <button key={t.kind} type="button" title={t.title} aria-label={t.title} className={barButton} onClick={() => format(t.kind)}>
                    {t.label}
                  </button>
                ))}
                <span className="flex-1" />
                {fsButton}
              </div>
              <CodeEditor label="Instructions (Markdown)" value={body} textareaRef={bodyRef} onChange={(v) => edit({ kind: "body", body: v })} />
              <ValidationBar checks={checks} doc={doc} />
            </div>
            <div className={`${paneClass} bg-[var(--color-surface-2)] ${pane === "preview" ? "" : "hidden lg:flex"}`}>
              <div className={barClass}>
                <b className="text-xs">Preview</b>
                <span className="flex-1" />
                <span className="text-xs text-[var(--color-muted)]">as the agent and the viewer see it</span>
              </div>
              <div className="max-h-[70vh] min-h-0 flex-1 overflow-auto bg-[var(--color-surface)] px-4 py-4 sm:px-6">
                <SkillMarkdown markdown={previewBody} />
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className={`${paneClass} min-h-[560px] ${fullscreenWrap}`}>
          <div className={barClass}>
            <b className="text-xs">SKILL.md</b>
            <span className="ml-2 hidden text-xs text-[var(--color-muted)] sm:inline">the whole file: YAML header + Markdown, exactly as stored</span>
            <span className="flex-1" />
            <CopyButton text={doc} className={barButton} />
            <button type="button" className={barButton} onClick={() => downloadText("SKILL.md", doc)}>
              Download
            </button>
            {fsButton}
          </div>
          <CodeEditor label="SKILL.md" value={doc} onChange={(v) => edit({ kind: "plain", doc: v })} />
          <ValidationBar checks={checks} doc={doc} />
        </div>
      )}

      {dirty ? (
        <div
          data-component="SkillSaveBar"
          className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 shadow-[0_-4px_16px_#0000001a]"
        >
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-px text-[11px] text-[var(--color-warn-text)]">
            ● Unsaved changes · {changed} {changed === 1 ? "line" : "lines"}
          </span>
          <span className="hidden flex-1 text-xs text-[var(--color-muted)] sm:inline">
            Changes apply to new chats; chats already running keep the version they started with.
          </span>
          <span className="flex-1 sm:hidden" />
          <button type="button" className={secondaryButtonClass} onClick={discard}>
            Discard
          </button>
          <button type="button" className={primaryButtonClass} onClick={() => setReviewing(true)}>
            Review &amp; save
          </button>
        </div>
      ) : null}

      {reviewing ? (
        <ReviewDialog
          name={name}
          profile={profile}
          builtin={skill?.source === "builtin"}
          ops={ops}
          checks={checks}
          error={saveError}
          onSave={save}
          onClose={() => {
            setReviewing(false);
            setSaveError(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ReviewDialog({
  name,
  profile,
  builtin,
  ops,
  checks,
  error,
  onSave,
  onClose,
}: {
  name: string;
  profile: string;
  builtin: boolean;
  ops: ReturnType<typeof diffLines>;
  checks: Check[];
  error: string | null;
  onSave(): Promise<void>;
  onClose(): void;
}) {
  const errors = checks.filter((c) => c.level === "error");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div
      data-component="SkillReviewDialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-review-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[90vh] w-full flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:w-[min(680px,100%)] sm:rounded-2xl">
        <h2 id="skill-review-title" className="text-[17px] font-semibold">
          Save changes to {name}?
        </h2>
        <p className="mb-2.5 mt-1 text-xs text-[var(--color-muted)]">
          {builtin
            ? `Saving changes this built-in skill's copy in profile ${profile}. Other profiles keep theirs, and Hermes updates will no longer replace this one.`
            : `Saving replaces SKILL.md in profile ${profile}. Other profiles keep their own copy.`}
        </p>
        <div data-component="SkillDiff" className="min-h-0 flex-1 overflow-auto rounded-xl bg-[var(--color-surface-2)] py-2 font-mono text-[12.5px] leading-relaxed">
          {hunks(ops).map((h, k) =>
            "skipped" in h ? (
              <div key={k} className="px-3 text-[var(--color-muted)]">
                … {h.skipped} unchanged {h.skipped === 1 ? "line" : "lines"}
              </div>
            ) : (
              h.ops.map((op, j) => (
                <div
                  key={`${k}-${j}`}
                  data-op={op.type}
                  className={`whitespace-pre px-3 ${op.type === "add" ? "bg-emerald-500/15 text-emerald-300" : op.type === "del" ? "bg-red-500/15 text-red-300" : ""}`}
                >
                  {op.type === "add" ? "+ " : op.type === "del" ? "- " : "  "}
                  {op.text}
                </div>
              ))
            ),
          )}
        </div>
        {errors.length ? (
          <ul role="alert" className="mt-3 space-y-0.5 text-sm text-[var(--color-danger)]">
            {errors.map((c, k) => (
              <li key={k}>✕ {c.text}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Keep editing
          </button>
          <ActionButton className={primaryButtonClass} disabled={hasErrors(checks)} busyLabel="Saving…" onAction={onSave}>
            Save
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { ActionButton } from "@/components/ui/ActionButton";

import { Spinner } from "@/components/ui/Spinner";
import {
  CHAT_CATEGORY_LABELS,
  CHAT_CATEGORY_ORDER,
  isCategoryOverrideTag,
  type ChatCategory,
} from "@/lib/chat/categorize";
import type { SessionSummary, SessionTag, TagSuggestion } from "@/types";

function absolute(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function relative(ts: number | null): string {
  if (!ts) return "—";
  const secs = Math.max(0, Date.now() / 1000 - ts);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function statusOf(s: SessionSummary): string {
  if (s.ended_at) return "Ended";
  return s.is_active ? "Active" : "Idle";
}

function formatTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0">
      <span className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-sm text-[var(--color-fg)]">
        {value}
      </span>
    </div>
  );
}

/** Tag colors — maps to CSS custom property names. */
const TAG_COLORS: Record<string, string> = {
  blue: "var(--color-accent)",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  purple: "#a855f7",
  gray: "var(--color-muted)",
};

function tagBg(color: string): string {
  const c = TAG_COLORS[color] ?? TAG_COLORS.blue;
  return `${c}1a`; // ~10% opacity hex suffix
}

/**
 * The conversation details popup, opened by tapping the active session chip.
 * Lets the user edit the conversation name (persisted via the BFF rename route),
 * shows read-only statistics, a collapsible context-window breakdown, a
 * Category field (which chat-list group this conversation belongs to — see
 * `lib/chat/categorize.ts`), and a tag management section with LLM-suggested
 * tags.
 */
export function SessionModal({
  session,
  onClose,
  onRename,
  onArchive,
  category,
  onSetCategory,
  tags,
  allTags,
  tagSuggestions,
  onAddTag,
  onRemoveTag,
  onAcceptSuggestion,
  onDismissSuggestion,
}: {
  session: SessionSummary;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive: () => Promise<void>;
  /** The category this conversation currently displays under (derived, or
   * a manual override already applied) — see `categorizeSession`. */
  category?: ChatCategory;
  onSetCategory?: (category: ChatCategory) => Promise<void>;
  tags?: SessionTag[];
  allTags?: SessionTag[];
  tagSuggestions?: TagSuggestion[];
  onAddTag?: (tagName: string) => Promise<void>;
  onRemoveTag?: (tagId: string) => Promise<void>;
  onAcceptSuggestion?: (suggestion: TagSuggestion) => Promise<void>;
  onDismissSuggestion?: (suggestion: TagSuggestion) => Promise<void>;
}) {
  const [name, setName] = useState(session.title ?? "");
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);
  // Every write here mutates the same conversation, so any one of them in flight
  // disables all of them: renaming a session while its archive request is still
  // applying would race two decisions about the same row.
  const busy = saving || archiving || tagBusy || categoryBusy;

  // The reserved category:<value> tags are how the override is actually
  // stored, but they're an implementation detail — never show them in the
  // generic Tags list, only through the dedicated Category field below.
  const visibleTags = tags?.filter((t) => !isCategoryOverrideTag(t));
  const visibleAllTags = allTags?.filter((t) => !isCategoryOverrideTag(t));

  async function setCategory(next: ChatCategory) {
    if (!onSetCategory || categoryBusy || next === category) return;
    setCategoryBusy(true);
    setError(null);
    try {
      await onSetCategory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change category.");
    } finally {
      setCategoryBusy(false);
    }
  }

  const inputTokens = session.input_tokens ?? 0;
  const outputTokens = session.output_tokens ?? 0;
  const cacheRead = session.cache_read_tokens ?? 0;
  const cacheWrite = session.cache_write_tokens ?? 0;
  const reasoning = session.reasoning_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite + reasoning;

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed.");
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (archiving) return;
    setArchiving(true);
    setError(null);
    try {
      await onArchive();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed.");
    } finally {
      setArchiving(false);
    }
  }

  async function addTag(tagName: string) {
    if (!tagName || !onAddTag || tagBusy) return;
    setTagBusy(true);
    setError(null);
    try {
      await onAddTag(tagName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to associate tag.");
    } finally {
      setTagBusy(false);
    }
  }

  async function removeTag(tagId: string) {
    if (!onRemoveTag || tagBusy) return;
    setTagBusy(true);
    setError(null);
    try {
      await onRemoveTag(tagId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove tag.");
    } finally {
      setTagBusy(false);
    }
  }

  async function acceptSuggestion(s: TagSuggestion) {
    if (!onAcceptSuggestion || tagBusy) return;
    setTagBusy(true);
    setError(null);
    try {
      await onAcceptSuggestion(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept tag.");
    } finally {
      setTagBusy(false);
    }
  }

  async function dismissSuggestion(s: TagSuggestion) {
    if (!onDismissSuggestion || tagBusy) return;
    setTagBusy(true);
    setError(null);
    try {
      await onDismissSuggestion(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss tag.");
    } finally {
      setTagBusy(false);
    }
  }

  return (
    <div
      data-component="SessionModal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Conversation</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[var(--color-muted)]"
          >
            Close
          </button>
        </div>

        <label className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Name
        </label>
        <input
          type="text"
          value={name}
          maxLength={200}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="Untitled conversation"
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />

        {error ? (
          <p className="mt-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        ) : null}

        {/* ── Category ── */}
        {category ? (
          <div className="mt-4">
            <label
              htmlFor="session-category"
              className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-muted)]"
            >
              Category
              {categoryBusy ? (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] normal-case"
                >
                  <Spinner />
                  Saving…
                </span>
              ) : null}
            </label>
            <select
              id="session-category"
              value={category}
              disabled={!onSetCategory || categoryBusy}
              onChange={(e) => void setCategory(e.target.value as ChatCategory)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] disabled:opacity-60"
            >
              {CHAT_CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CHAT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {/* ── Context Window (collapsible) ── */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setCtxCollapsed((v) => !v)}
            className="flex w-full items-center justify-between text-xs uppercase tracking-wide text-[var(--color-muted)]"
          >
            <span>Context Window</span>
            <span className="text-[var(--color-fg)]">
              {ctxCollapsed ? "▶" : "▼"}
            </span>
          </button>
          {!ctxCollapsed && (
            <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs text-[var(--color-muted)]">Total tokens</span>
                <span className="font-mono text-sm font-semibold text-[var(--color-fg)]">
                  {formatTokens(totalTokens)}
                </span>
              </div>
              {/* Token breakdown bar */}
              <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                {totalTokens > 0 && (
                  <>
                    {inputTokens > 0 && (
                      <div style={{ width: `${(inputTokens / totalTokens) * 100}%`, background: "var(--color-accent)" }} />
                    )}
                    {outputTokens > 0 && (
                      <div style={{ width: `${(outputTokens / totalTokens) * 100}%`, background: "#22c55e" }} />
                    )}
                    {cacheRead > 0 && (
                      <div style={{ width: `${(cacheRead / totalTokens) * 100}%`, background: "#a855f7" }} />
                    )}
                    {cacheWrite > 0 && (
                      <div style={{ width: `${(cacheWrite / totalTokens) * 100}%`, background: "#f59e0b" }} />
                    )}
                    {reasoning > 0 && (
                      <div style={{ width: `${(reasoning / totalTokens) * 100}%`, background: "#ef4444" }} />
                    )}
                  </>
                )}
              </div>
              {/* Breakdown rows */}
              <div className="space-y-1">
                {inputTokens > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-accent)" }} />
                      Input
                    </span>
                    <span className="font-mono text-[var(--color-fg)]">{formatTokens(inputTokens)}</span>
                  </div>
                )}
                {outputTokens > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#22c55e" }} />
                      Output
                    </span>
                    <span className="font-mono text-[var(--color-fg)]">{formatTokens(outputTokens)}</span>
                  </div>
                )}
                {cacheRead > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#a855f7" }} />
                      Cache read
                    </span>
                    <span className="font-mono text-[var(--color-fg)]">{formatTokens(cacheRead)}</span>
                  </div>
                )}
                {cacheWrite > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />
                      Cache write
                    </span>
                    <span className="font-mono text-[var(--color-fg)]">{formatTokens(cacheWrite)}</span>
                  </div>
                )}
                {reasoning > 0 && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#ef4444" }} />
                      Reasoning
                    </span>
                    <span className="font-mono text-[var(--color-fg)]">{formatTokens(reasoning)}</span>
                  </div>
                )}
                {totalTokens === 0 && (
                  <p className="text-xs text-[var(--color-muted)]">No token data for this session.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Tags ── */}
        {visibleTags && (
          <div className="mt-4">
            <h3 className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Tags
              {tagBusy ? (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1 text-[var(--color-accent)] normal-case"
                >
                  <Spinner />
                  Saving…
                </span>
              ) : null}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {visibleTags.map((tag) => (
                <span
                  key={tag.id}
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                  style={{ background: tagBg(tag.color), color: TAG_COLORS[tag.color] ?? TAG_COLORS.blue }}
                >
                  {tag.name}
                  {onRemoveTag && (
                    <ActionButton
                      onAction={() => removeTag(tag.id)}
                      disabled={tagBusy}
                      className="ml-0.5 text-xs opacity-60 hover:opacity-100 disabled:opacity-30"
                      aria-label={`Remove tag ${tag.name}`}
                    >
                      ×
                    </ActionButton>
                  )}
                </span>
              ))}
              {visibleTags.length === 0 && (
                <span className="text-xs text-[var(--color-muted)]">No tags yet.</span>
              )}
            </div>
            {onAddTag && visibleAllTags && (() => {
              const associatedNames = new Set(
                (visibleTags ?? []).map((t) => t.name.toLowerCase()),
              );
              const available = visibleAllTags.filter(
                (t) => !associatedNames.has(t.name.toLowerCase()),
              );
              if (available.length === 0) {
                return (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    {visibleTags && visibleTags.length > 0
                      ? "All tags associated."
                      : "No tags defined yet. Create them in Settings."}
                  </p>
                );
              }
              return (
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) void addTag(v);
                    e.target.value = "";
                  }}
                  disabled={tagBusy}
                  className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-fg)] disabled:opacity-60"
                >
                  <option value="" disabled>
                    Associate tag…
                  </option>
                  {available.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              );
            })()}
          </div>
        )}

        {/* ── Tag suggestions from LLM ── */}
        {tagSuggestions && tagSuggestions.length > 0 && (
          <div className="mt-3">
            <h3 className="mb-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Suggested
            </h3>
            <div className="space-y-1.5">
              {tagSuggestions.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-[var(--color-fg)]">
                      {s.tag_name}
                    </span>
                    {s.reason && (
                      <span className="ml-1.5 text-xs text-[var(--color-muted)]">
                        {s.reason}
                      </span>
                    )}
                    {s.is_new && (
                      <span className="ml-1.5 rounded-full bg-[var(--color-accent)] px-1.5 py-0 text-[0.625rem] text-[var(--color-accent-fg)]">
                        new
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <ActionButton
                      onAction={() => acceptSuggestion(s)}
                      disabled={tagBusy}
                      className="rounded-lg bg-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
                    >
                      Accept
                    </ActionButton>
                    <ActionButton
                      onAction={() => dismissSuggestion(s)}
                      disabled={tagBusy}
                      className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)] disabled:opacity-60"
                    >
                      Dismiss
                    </ActionButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Statistics ── */}
        <div className="mt-4">
          <h3 className="mb-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Statistics
          </h3>
          <Stat label="Messages" value={String(session.message_count)} />
          <Stat label="Source" value={session.source} />
          <Stat label="Status" value={statusOf(session)} />
          <Stat label="Started" value={absolute(session.started_at)} />
          <Stat label="Last active" value={relative(session.last_active)} />
          <Stat label="Session id" value={session.id} />
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <ActionButton
            onAction={archive}
            disabled={busy}
            busy={archiving}
            busyLabel="Archiving…"
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-muted)] disabled:opacity-60"
          >
            Archive
          </ActionButton>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <ActionButton
              onAction={save}
              disabled={busy}
              busy={saving}
              busyLabel="Saving…"
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
            >
              Save
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";

import { dockComposer } from "@/lib/chat/composer-dock";
import { takePendingAttachments } from "@/lib/chat/pending-attachments";
import { parseJsonObject, uploadFailureMessage } from "@/lib/chat/upload-error";
import { formatUploadLimit, UPLOAD_WARN_BYTES } from "@/lib/chat/upload-limit";
import { uploadLimitBytes } from "@/lib/chat/upload-limit-client";
import type { ChatAttachment, ChatInputMode, ChatSendResult, PendingChatInput } from "@/types";

/** Smallest limit Settings → Uploads allows: smaller files skip the lookup. */
const MIN_LIMIT_BYTES = 1024 * 1024;

/** The Send split button's modes while the agent works, in menu order. */
const INPUT_MODES: { mode: ChatInputMode; label: string; hint: string; enter: string }[] = [
  {
    mode: "steer",
    label: "Steer",
    hint: "Agent reads it after its current step and changes course",
    enter: "Enter steers",
  },
  {
    mode: "queue",
    label: "Queue",
    hint: "Runs as the next turn when this one finishes",
    enter: "Enter queues",
  },
  {
    mode: "interrupt",
    label: "Stop & send",
    hint: "Stops now and starts this message",
    enter: "Enter stops & sends",
  },
];

function modeInfo(mode: ChatInputMode) {
  return INPUT_MODES.find((m) => m.mode === mode) ?? INPUT_MODES[0];
}

function ModeIcon({ mode }: { mode: ChatInputMode }) {
  if (mode === "interrupt") {
    return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px] bg-current" />;
  }
  return <span aria-hidden="true">{mode === "queue" ? "◷" : "↪"}</span>;
}

/** One chip's wording: what will happen to a message sent while working. */
function chipText(p: PendingChatInput): { label: string; suffix: string | null } {
  if (p.mode === "queue") return { label: "Queued next", suffix: null };
  if (p.mode === "interrupt") return { label: "Stop & send", suffix: "starts once the agent stops" };
  if (p.status === "delivered") return { label: "Delivered ✓", suffix: null };
  return {
    label: "Steer",
    suffix: p.status === "deferred" ? "will run next" : "will be read after the current step",
  };
}

/**
 * Messages sent while the agent works that have not reached the model yet.
 * Queued ones can still be taken back (✕) until they start.
 */
function PendingInputs({
  pending,
  onRemove,
}: {
  pending: PendingChatInput[];
  onRemove?: (itemId: string) => void;
}) {
  if (pending.length === 0) return null;
  return (
    <ul data-component="PendingInputs" aria-label="Sent while working" className="mb-2 flex flex-col items-start gap-1.5">
      {pending.map((p) => {
        const { label, suffix } = chipText(p);
        return (
          <li
            key={p.itemId}
            data-mode={p.mode}
            data-status={p.status}
            className="flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs"
          >
            <span className="shrink-0 text-[var(--color-muted)]">
              <ModeIcon mode={p.mode} />
            </span>
            <span className="shrink-0 font-semibold">{label}</span>
            <span className="min-w-0 truncate text-[var(--color-muted)]">
              “{p.text}”{suffix ? ` · ${suffix}` : ""}
            </span>
            {p.mode === "queue" && onRemove ? (
              <button
                type="button"
                aria-label={`Remove queued message: ${p.text}`}
                title="Remove from the queue"
                onClick={() => onRemove(p.itemId)}
                className="shrink-0 px-0.5 text-[var(--color-muted)]"
              >
                ✕
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The message composer: an auto-clearing text field, an optional attach button
 * (present only when Storage is configured on the box), and a send button.
 * Uploads route through the `agent-home` BFF so the browser never holds a
 * storage key; attachment chips are included on the next send.
 */
export function Composer({
  sending,
  storageEnabled,
  sessionId,
  onSend,
  onStop,
  stopping = false,
  initialText = "",
  launcherClearance = true,
  pending = [],
  onRemovePending,
  narrow = false,
  onMenuOpenChange,
}: {
  sending: boolean;
  /** A Stop was requested and the server is winding the turn down. */
  stopping?: boolean;
  storageEnabled: boolean;
  sessionId: string | null;
  /** Pre-filled text (a deep link's `?draft=`); the user still presses send. */
  initialText?: string;
  /**
   * Resolves `false` when the message never reached the agent (a transport
   * failure, not a mid-turn error) — the composer then puts the draft and
   * its attachments back so nothing is lost to a flaky network. Any other
   * resolution (void/true/undefined) leaves the field cleared.
   * `"attachments_kept"` means the text was delivered but the files were
   * not (a running turn takes text only): the files go back into the box.
   */
  onSend: (
    text: string,
    attachments: ChatAttachment[],
    /** Set only while the agent works: how the message reaches the running turn. */
    mode?: ChatInputMode,
  ) => void | Promise<ChatSendResult | void> | ChatSendResult;
  /** Cancel the in-flight turn for the conversation on screen. */
  onStop?: () => void;
  /**
   * Left margin that keeps the composer clear of the left-edge Coral
   * launcher. Off where the layout already clears it (the landing dock).
   */
  launcherClearance?: boolean;
  /** Messages sent while the agent works that it has not read yet (chips). */
  pending?: PendingChatInput[];
  /** Take back a queued message before it starts. */
  onRemovePending?: (itemId: string) => void;
  /**
   * The composer sits in a narrow panel (the lead chat), so while working it
   * uses the phone layout at every screen width: actions below the input.
   */
  narrow?: boolean;
  /** The mode menu opened or closed (the host may need to lift itself too). */
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [oversizeFiles, setOversizeFiles] = useState<File[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // A file sent here from Files → Browse ("Ask the agent about this file").
  // Read after mount (sessionStorage is browser-only, so not in the initial
  // state: the server render must match the first client render).
  useEffect(() => {
    queueMicrotask(() => {
      const pending = takePendingAttachments();
      if (pending.length > 0) setAttachments((prev) => [...prev, ...pending]);
    });
  }, []);

  // Grow the input to fit its content (starting at one row) up to a max height,
  // then let it scroll. Runs on every text change and after clearing on send.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const [mode, setMode] = useState<ChatInputMode>("steer");
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Keep the floating lead-chat launcher off the Send controls.
  useEffect(() => (rootRef.current ? dockComposer(rootRef.current) : undefined), []);

  // While the agent works a message goes to the running turn, which takes
  // text only — attachments stay in the box for the next normal turn.
  const attachmentsWait = sending && attachments.length > 0;
  const menuShown = sending && menuOpen;
  useEffect(() => onMenuOpenChange?.(menuShown), [menuShown, onMenuOpenChange]);
  // Working on a phone (or in a narrow panel) the actions wrap below a
  // full-width input; the left-launcher reserve then moves onto that row.
  const reserve = launcherClearance
    ? !sending
      ? " ml-14"
      : narrow
        ? ""
        : " ml-14 max-sm:ml-0"
    : "";
  const canSend =
    !uploading &&
    (sending ? text.trim() !== "" : text.trim() !== "" || attachments.length > 0);

  // Close the mode menu on Escape or a press outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (splitRef.current && !splitRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  // A normal send hands the turn to the host and resolves when the whole
  // turn ends — far too late to hold the send lock, since the box must take
  // a steer while the agent works. Instead the hand-off holds it until the
  // host reports `sending` (or the turn fails to start).
  const handoffRef = useRef(false);
  useEffect(() => {
    if (sending) handoffRef.current = false;
  }, [sending]);

  async function submit() {
    if (!canSend || handoffRef.current) return;
    const sent = text.trim();
    const sentAttachments = sending ? [] : attachments;
    setText("");
    setMenuOpen(false);
    // The turn never started — the error line names why; give the draft
    // back (unless the user already typed something new) so they retry
    // instead of retyping.
    const restore = (ok: ChatSendResult | void) => {
      if (ok === "attachments_kept") {
        if (sentAttachments.length > 0) setAttachments((cur) => [...sentAttachments, ...cur]);
        return;
      }
      if (ok !== false) return;
      setText((cur) => (cur === "" ? sent : cur));
      if (sentAttachments.length > 0) setAttachments(sentAttachments);
    };
    if (sending) {
      // Stop & send is a one-off; the next message steers again.
      // Files in the box are not sent; they wait for the next normal turn.
      if (mode === "interrupt") setMode("steer");
      void Promise.resolve(onSend(sent, [], mode)).then(restore, () => restore(false));
      return;
    }
    setAttachments([]);
    handoffRef.current = true;
    void Promise.resolve(onSend(sent, sentAttachments))
      .then(restore, () => restore(false))
      .finally(() => {
        handoffRef.current = false;
      });
  }

  // Enter and the Send button share one lock, so a double Enter (or Enter
  // then a click) before the cleared box renders cannot send the text twice.
  const { run: sendOnce } = useAction(submit);

  async function pickFiles(files: File[]) {
    setUploadError(null);
    if (files.some((f) => f.size > MIN_LIMIT_BYTES)) {
      const limit = await uploadLimitBytes();
      const tooBig = limit === null ? [] : files.filter((f) => f.size > limit);
      if (limit !== null && tooBig.length > 0) {
        setUploadError(
          `${tooBig.map((f) => f.name).join(", ")}: over the ${formatUploadLimit(limit)} upload limit.`,
        );
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
    }
    const oversize = files.filter((f) => f.size > UPLOAD_WARN_BYTES);
    if (oversize.length > 0) {
      // Advisory gate: the user confirms oversized files rather than being
      // refused — the server enforces whatever real cap the backend has.
      setOversizeFiles(files);
      return;
    }
    void upload(files);
  }

  async function upload(files: File[]) {
    setUploadError(null);
    setOversizeFiles(null);
    setUploading(true);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        if (sessionId) form.set("sessionId", sessionId);
        let res: Response;
        let text: string;
        try {
          res = await fetch("/api/chat/upload", { method: "POST", body: form });
          text = await res.text();
        } catch (err) {
          const why = err instanceof Error && err.message ? ` (${err.message})` : "";
          throw new Error(`${file.name}: Upload failed: the server could not be reached${why}.`);
        }
        const body = res.ok ? parseJsonObject<ChatAttachment>(text) : null;
        if (!res.ok || !body?.path) {
          throw new Error(uploadFailureMessage(file.name, res.status, text));
        }
        setAttachments((prev) => [...prev, body]);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div
      ref={rootRef}
      data-component="Composer"
      // Lift the open mode menu (and its phone backdrop) above the floating launchers.
      className={`sticky bottom-0 mt-3 bg-[var(--color-bg)] pt-2${reserve}${menuShown ? " z-[70]" : ""}`}
      style={{ bottom: "var(--safe-bottom)" }}
    >
      {sending ? <PendingInputs pending={pending} onRemove={onRemovePending} /> : null}
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span
              key={a.path}
              className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] px-2 py-1 text-xs"
            >
              {a.name}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() =>
                  setAttachments((prev) => prev.filter((x) => x.path !== a.path))
                }
                className="text-[var(--color-muted)]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachmentsWait ? (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Messages sent now go to the running turn as text; attachments go with your next prompt
          once the agent finishes.
        </p>
      ) : null}
      {uploadError ? (
        <p className="mb-2 text-xs text-[var(--color-danger)]">{uploadError}</p>
      ) : null}
      {oversizeFiles ? (
        <div
          data-component="OversizeConfirm"
          className="mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs"
        >
          <p className="text-[var(--color-muted)]">
            {oversizeFiles.filter((f) => f.size > UPLOAD_WARN_BYTES).length === 1
              ? `${oversizeFiles.find((f) => f.size > UPLOAD_WARN_BYTES)?.name} is over 100 MB — it may take a while to upload.`
              : `${oversizeFiles.filter((f) => f.size > UPLOAD_WARN_BYTES).length} files are over 100 MB — they may take a while to upload.`}
          </p>
          <div className="mt-2 flex gap-2">
            <ActionButton
              onAction={() => upload(oversizeFiles)}
              busy={uploading}
              busyLabel="Uploading…"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-medium text-[var(--color-accent-fg)]"
            >
              Upload anyway
            </ActionButton>
            <button
              type="button"
              onClick={() => {
                setOversizeFiles(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {/* On a phone while working, the input takes the full width and the actions wrap below it. */}
      <div
        className={`flex items-end gap-2${sending ? (narrow ? " flex-wrap" : " max-sm:flex-wrap") : ""}`}
      >
        {storageEnabled ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) void pickFiles(files);
              }}
            />
            <button
              type="button"
              aria-label="Attach file"
              title="Attach a file (image, PDF, DOC, XLS, …)"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-sm disabled:opacity-60${
                sending && launcherClearance ? (narrow ? " ml-14" : " max-sm:ml-14") : ""
              }`}
            >
              {uploading ? "…" : "+"}
            </button>
          </>
        ) : null}
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendOnce();
            }
          }}
          rows={1}
          placeholder={
            sending
              ? "Steer the agent, or queue a follow-up…"
              : "Message your agent… (Shift+Enter for a new line)"
          }
          className={`max-h-48 min-h-[46px] flex-1 resize-none overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-sm${
            sending
              ? narrow
                ? " order-first basis-full"
                : " max-sm:order-first max-sm:basis-full"
              : ""
          }`}
        />
        {sending ? (
          <>
            <span
              className={`hidden self-center whitespace-nowrap text-xs text-[var(--color-muted)]${
                narrow ? "" : " lg:inline"
              }`}
            >
              Agent is working · {modeInfo(mode).enter}
            </span>
            <ActionButton
              key="stop"
              onAction={() => onStop?.()}
              busy={stopping}
              busyLabel="Stopping…"
              aria-label={stopping ? "Stopping the agent" : "Stop the agent"}
              title={stopping ? "Stopping the agent" : "Stop the agent"}
              className={`flex items-center gap-1.5 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white disabled:opacity-60 ${
                narrow ? "ml-auto px-3" : "px-4 max-sm:ml-auto max-sm:px-3"
              }`}
            >
              <span aria-hidden="true" className="h-3 w-3 rounded-[3px] bg-white" />
              <span className={narrow ? "sr-only" : "max-sm:sr-only"}>Stop</span>
            </ActionButton>
            <div ref={splitRef} data-component="SendSplit" className="relative flex">
              <ActionButton
                key="send-mode"
                onAction={sendOnce}
                disabled={!canSend}
                busyLabel="Sending…"
                title={modeInfo(mode).hint}
                className="rounded-l-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
              >
                {modeInfo(mode).label}
              </ActionButton>
              <button
                type="button"
                aria-label="Choose how to send"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((cur) => !cur)}
                className="rounded-r-xl border-l border-[color-mix(in_srgb,var(--color-accent-fg)_30%,transparent)] bg-[var(--color-accent)] px-2 py-3 text-xs text-[var(--color-accent-fg)]"
              >
                ▾
              </button>
              {menuOpen ? (
                <>
                  <div
                    aria-hidden="true"
                    data-component="SendModeBackdrop"
                    className="fixed inset-0 z-40 bg-black/40 sm:hidden"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    aria-label="Send mode"
                    data-component="SendModeMenu"
                    className="z-50 flex flex-col gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:rounded-t-2xl max-sm:pb-[calc(var(--safe-bottom)+0.75rem)] sm:absolute sm:bottom-full sm:right-0 sm:mb-2 sm:w-80 sm:rounded-xl"
                  >
                    {INPUT_MODES.map((m) => (
                      <button
                        key={m.mode}
                        type="button"
                        role="menuitemradio"
                        aria-checked={mode === m.mode}
                        onClick={() => {
                          setMode(m.mode);
                          setMenuOpen(false);
                          textRef.current?.focus();
                        }}
                        className={`flex flex-col items-start rounded-lg px-3 py-2 text-left max-sm:py-3 ${
                          mode === m.mode ? "bg-[var(--color-surface-2)]" : ""
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-sm font-semibold">
                          <ModeIcon mode={m.mode} />
                          {m.label}
                        </span>
                        <span className="text-xs text-[var(--color-muted)]">{m.hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <ActionButton
            key="send"
            onAction={sendOnce}
            disabled={!canSend}
            busyLabel="Sending…"
            className="rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            Send
          </ActionButton>
        )}
      </div>
    </div>
  );
}

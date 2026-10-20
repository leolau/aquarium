"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { takePendingAttachments } from "@/lib/chat/pending-attachments";
import { UPLOAD_WARN_BYTES } from "@/lib/chat/upload-limit";
import type { ChatAttachment } from "@/types";

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
   */
  onSend: (text: string, attachments: ChatAttachment[]) => void | Promise<boolean | void> | boolean;
  /** Cancel the in-flight turn for the conversation on screen. */
  onStop?: () => void;
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

  const canSend = !sending && !uploading && (text.trim() !== "" || attachments.length > 0);

  async function submit() {
    if (!canSend) return;
    const sent = text.trim();
    const sentAttachments = attachments;
    setText("");
    setAttachments([]);
    const ok = await onSend(sent, sentAttachments);
    if (ok === false) {
      // The turn never started — the error line names why; give the draft
      // back so the user retries instead of retyping.
      setText(sent);
      setAttachments(sentAttachments);
    }
  }

  function pickFiles(files: File[]) {
    setUploadError(null);
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
        const res = await fetch("/api/chat/upload", { method: "POST", body: form });
        const body = (await res.json()) as (ChatAttachment & { detail?: string });
        if (!res.ok) {
          throw new Error(`${file.name}: ${body.detail ?? "Upload failed."}`);
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
      data-component="Composer"
      className="sticky bottom-0 mt-3 bg-[var(--color-bg)] pt-2"
      style={{
        bottom: "var(--safe-bottom)",
        marginLeft: "calc(2.75rem + 0.75rem)",
      }}
    >
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
      {uploadError ? (
        <p className="mb-2 text-xs text-red-300">{uploadError}</p>
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
            <button
              type="button"
              onClick={() => void upload(oversizeFiles)}
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-medium text-[var(--color-accent-fg)]"
            >
              Upload anyway
            </button>
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
      <div className="flex items-end gap-2">
        {storageEnabled ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) pickFiles(files);
              }}
            />
            <button
              type="button"
              aria-label="Attach file"
              title="Attach a file (image, PDF, DOC, XLS, …)"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-sm disabled:opacity-60"
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
              submit();
            }
          }}
          rows={1}
          placeholder="Message your agent… (Shift+Enter for a new line)"
          className="max-h-48 min-h-[46px] flex-1 resize-none overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-sm"
        />
        {sending ? (
          <button
            type="button"
            onClick={() => onStop?.()}
            disabled={stopping}
            aria-label={stopping ? "Stopping the agent" : "Stop the agent"}
            title={stopping ? "Stopping the agent" : "Stop the agent"}
            className="flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            <span aria-hidden="true" className="h-3 w-3 rounded-[3px] bg-white" />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className="rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

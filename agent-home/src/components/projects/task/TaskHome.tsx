"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FileDropZone } from "@/components/projects/inputs/FileDropZone";
import { useUploadQueue } from "@/components/projects/inputs/useUploadQueue";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import type {
  ProfileSummary,
  ProjectAutonomy,
  ProjectListItem,
  QuickTaskResponse,
  QuickTaskStartResponse,
  ViewDevice,
} from "@/types";

import {
  CHECK_IN_CHOICES,
  DEFAULT_CHECK_IN,
  projectHref,
  taskBucket,
  taskLists,
} from "./viewMode";

/** Prefills for the ask box; picking one only fills the text. */
export const SUGGESTIONS: readonly string[] = [
  "Summarise this document into one page",
  "Research a topic and write a short brief",
  "Draft an email reply",
  "Compare these files and list the differences",
];

const LIST_LIMIT = 5;

const SECTION =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3";

/**
 * Task mode's Projects home: one ask box to start a task, then what needs
 * the person, what is running and what finished. Only one-off projects are
 * tasks; the server already returned only what this person may see.
 */
export function TaskHome({
  items,
  profiles,
  defaultProfile,
  canStart,
  device,
  onShowProjects,
}: {
  items: ProjectListItem[];
  profiles: ProfileSummary[];
  defaultProfile: string;
  /** Viewers see their tasks but cannot start one. */
  canStart: boolean;
  device: ViewDevice;
  onShowProjects: () => void;
}) {
  const lists = taskLists(items);
  const empty = lists.needsYou.length + lists.running.length + lists.done.length === 0;
  const box = canStart ? (
    <AskBox profiles={profiles} defaultProfile={defaultProfile} pinned={device === "phone"} />
  ) : null;

  return (
    <div data-component="TaskHome" className="flex flex-col gap-3">
      {device === "desktop" ? box : null}
      {empty ? (
        <p className="px-1 text-sm text-[var(--color-muted)]">
          No tasks yet.{canStart ? " Say what the agent should do above." : ""}
        </p>
      ) : null}
      <TaskSection title="Needs you" items={lists.needsYou} canRetry={canStart} />
      <TaskSection title="Running" items={lists.running} canRetry={canStart} />
      <TaskSection title="Done recently" items={lists.done} canRetry={canStart} />
      {lists.hiddenCount > 0 ? (
        <p data-component="TaskModeNote" className="px-1 text-xs text-[var(--color-muted)]">
          {lists.hiddenCount === 1
            ? "1 repeating or standing project stays in Project mode. "
            : `${lists.hiddenCount} repeating or standing projects stay in Project mode. `}
          <button type="button" onClick={onShowProjects} className="text-[var(--color-accent)] underline">
            Show them
          </button>
        </p>
      ) : null}
      {device === "phone" ? box : null}
    </div>
  );
}

function TaskSection({
  title,
  items,
  canRetry,
}: {
  title: string;
  items: ProjectListItem[];
  canRetry: boolean;
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, LIST_LIMIT);
  return (
    <section aria-label={title} data-component="TaskSection" className={SECTION}>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-[var(--color-border)] px-1.5 text-xs font-normal">{items.length}</span>
        <span className="flex-1" />
        {items.length > LIST_LIMIT ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="text-xs font-normal text-[var(--color-accent)]"
          >
            {all ? "Show fewer" : "See all"}
          </button>
        ) : null}
      </h2>
      <ul className="flex flex-col divide-y divide-[var(--color-border)]">
        {shown.map((item) => (
          <TaskRow key={item.id} item={item} canRetry={canRetry} />
        ))}
      </ul>
    </section>
  );
}

const BUCKET_LABEL = {
  needs_you: "Needs you",
  not_started: "Not started",
  running: "Running",
  done: "Done",
  failed: "Failed",
} as const;

function TaskRow({ item, canRetry }: { item: ProjectListItem; canRetry: boolean }) {
  const timeLabel = useTimeLabel();
  const retry = useProjectAction<QuickTaskStartResponse>();
  const bucket = taskBucket(item);
  return (
    <li data-component="TaskRow" data-bucket={bucket} className="flex items-center gap-2 py-2">
      <Link href={projectHref(item.slug)} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="block truncate text-xs text-[var(--color-muted)]">
          {BUCKET_LABEL[bucket]}
          {item.latest_run ? ` · run ${item.latest_run.run_no}` : ""} · {timeLabel(item.created_at, "ago")}
        </span>
      </Link>
      {(bucket === "failed" || bucket === "not_started") && canRetry ? (
        <button
          type="button"
          disabled={retry.busy}
          onClick={() =>
            void retry.run(`/api/projects/${encodeURIComponent(item.slug)}/quick-task/start`)
          }
          className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50"
        >
          {bucket === "not_started"
            ? retry.busy ? "Starting…" : "Start"
            : retry.busy ? "Retrying…" : "Retry"}
        </button>
      ) : null}
    </li>
  );
}

function AskBox({
  profiles,
  defaultProfile,
  pinned,
}: {
  profiles: ProfileSummary[];
  defaultProfile: string;
  pinned: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [profile, setProfile] = useState(defaultProfile);
  const [autonomy, setAutonomy] = useState<ProjectAutonomy>(DEFAULT_CHECK_IN);
  const [checkPlan, setCheckPlan] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const queue = useUploadQueue();
  const start = useProjectAction<QuickTaskResponse>();
  const [uploadFailed, setUploadFailed] = useState(false);
  const profileNames = profiles.length > 0 ? profiles.map((p) => p.name) : [defaultProfile];
  const request = text.trim();

  const submit = () => {
    if (!request || start.busy) return;
    setUploadFailed(false);
    void start.run("/api/projects/quick-task", {
      body: { request, host_profile: profile, autonomy, check_plan_first: checkPlan },
      skipRefresh: true,
      onSuccess: (task) => {
        const go = () => router.push(projectHref(task.slug));
        if (queue.items.length === 0) return go();
        void queue.uploadPending(task.slug).then((ok) => {
          if (ok) go();
          else setUploadFailed(true);
        });
      },
    });
  };

  return (
    <form
      data-component="TaskAskBox"
      aria-label="Start a task"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`${SECTION} flex flex-col gap-2 ${
        pinned ? "sticky bottom-2 z-10 gap-1.5 shadow-[0_-8px_16px_rgba(0,0,0,0.25)]" : ""
      }`}
    >
      <label className="sr-only" htmlFor="task-ask">
        What should the agent do?
      </label>
      <textarea
        id="task-ask"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={pinned ? 1 : 3}
        placeholder="What should the agent do?"
        className="w-full resize-none rounded-xl border border-[var(--color-border)] bg-transparent p-2 text-sm"
      />
      {!pinned ? (
        <div data-component="TaskSuggestions" className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setText(s)}
              className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted)]"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {attachOpen ? (
        <FileDropZone compact onFiles={(files) => queue.add(files)} chooseLabel="Choose files" />
      ) : null}
      {queue.items.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {queue.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5"
            >
              {item.file.name}
              {item.status === "failed" ? " · failed" : ""}
              {item.status === "queued" || item.status === "failed" ? (
                <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => queue.remove(item.id)}>
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          aria-expanded={attachOpen}
          onClick={() => setAttachOpen((v) => !v)}
          className="rounded-lg border border-[var(--color-border)] px-2.5 py-1"
        >
          📎 Attach
        </button>
        <label className="flex items-center gap-1">
          <span className="text-[var(--color-muted)]">Profile</span>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1"
          >
            {profileNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-[var(--color-muted)]">{pinned ? "Check in" : "Check in with me"}</span>
          <select
            value={autonomy}
            onChange={(e) => setAutonomy(e.target.value as ProjectAutonomy)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1"
          >
            {CHECK_IN_CHOICES.map((c) => (
              <option key={c.autonomy} value={c.autonomy}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`flex items-center gap-1 ${pinned ? "basis-full" : ""}`}>
          <input type="checkbox" checked={checkPlan} onChange={(e) => setCheckPlan(e.target.checked)} />
          Let me check the plan first
        </label>
        <span className="flex-1" />
        <button
          type="submit"
          disabled={!request || start.busy || queue.uploading}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {start.busy || queue.uploading ? "Starting…" : "Start task"}
        </button>
      </div>
      {start.error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {start.error}
        </p>
      ) : null}
      {uploadFailed ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          The task started, but some files didn&apos;t upload. Add them from the task page.
        </p>
      ) : null}
    </form>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Pill } from "@/components/ui/Pill";
import { inputClass, primaryButtonClass, secondaryButtonClass, Sheet } from "@/components/ui/Sheet";
import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import type {
  TriageKindStatus,
  TriageMissing,
  TriageSkillFile,
  TriageSkillFileContent,
  TriageSkillFileHistory,
  TriageStatus,
} from "@/types";

type Kind = TriageKindStatus["kind"];

const NOUN: Record<Kind, string> = { email: "mailbox", whatsapp: "WhatsApp number", calendar: "calendar" };

/** A `missing[]` reason from `GET /api/triage/status`, in plain words. */
export function missingText(kind: Kind, reason: TriageMissing): string {
  const noun = NOUN[kind];
  switch (reason) {
    case "account":
      return `No ${noun} of yours is connected yet`;
    case "triage":
      return `Your ${noun} is connected but isn't on triage`;
    case "enabled":
      return `Triage is turned off for your ${noun}`;
    case "credential":
      return `Your ${noun} has no saved sign-in`;
    case "other_person_polled":
      return `Another person's sign-in is the one polled for your ${noun}`;
    case "skills":
      return "The triage skill files are missing";
  }
}

/** Each skill file a kind's pipeline reads, once per path. */
function kindFiles(k: TriageKindStatus): TriageSkillFile[] {
  const seen = new Set<string>();
  return (k.skills ?? []).flatMap((s) => s.files ?? []).filter((f) => !seen.has(f.path) && seen.add(f.path));
}

/** The triage pipelines' own skill folders: never offered in the Add picker. */
export function triageSkillNames(status: TriageStatus | null): Set<string> {
  return new Set(
    kindsOf(status).flatMap((k) => (k.skills ?? []).filter((s) => s.layer === "base").map((s) => s.name)),
  );
}

/** `status.kinds`, or none for a missing or malformed reply. */
function kindsOf(status: TriageStatus | null): TriageKindStatus[] {
  return Array.isArray(status?.kinds) ? status.kinds : [];
}

type Open = { kind: Kind; file: TriageSkillFile; tab: "file" | "history" };

const WRAP =
  "rounded-[var(--radius-xl)] border border-[var(--color-warn)]/70 bg-[var(--color-attention-bg)] p-3 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warn)_12%,transparent)]";

/**
 * Agent Profiles → a profile → Skills: the highlighted Triage card on top.
 * Filled from `GET /api/triage/status?profile=` for that profile, so it only
 * ever shows the signed-in person's own triage setup there. Owners and admins
 * get Edit on each triage skill file; members and viewers get View (Hermes
 * refuses their saves too).
 */
export function TriageCard({
  profile,
  status,
  error,
}: {
  profile: string;
  status: TriageStatus | null;
  error?: string | null;
}) {
  const [open, setOpen] = useState<Open | null>(null);

  if (error) {
    return (
      <div data-component="TriageCard" data-state="error" className={WRAP}>
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          Couldn&apos;t check triage for {profile}: {error}
        </p>
      </div>
    );
  }
  if (!status) {
    return (
      <div data-component="TriageCard" data-state="loading" className={WRAP}>
        <p className="text-sm text-[var(--color-muted)]">Checking triage…</p>
      </div>
    );
  }

  const canEdit = status.can_edit === true;
  const kinds = kindsOf(status);
  const on = kinds.filter((k) => k.status === "set_up");
  const partly = kinds.filter((k) => k.status === "partly_set_up");
  const off = kinds.filter((k) => k.status === "not_set_up");
  const state = on.length ? "set_up" : partly.length ? "partly_set_up" : "not_set_up";
  const headline = { set_up: "set up for you", partly_set_up: "partly set up", not_set_up: "not set up yet" }[state];
  const pill = { set_up: ["On", "success"], partly_set_up: ["Partly", "warning"], not_set_up: ["Off", "warning"] } as const;

  return (
    <div data-component="TriageCard" data-state={state} className={WRAP}>
      <div className="flex items-center gap-2">
        <span className="text-base text-[var(--color-warn-text)]" aria-hidden>
          ◆
        </span>
        <span className="flex-1 font-semibold text-[var(--color-fg)]">Triage · {headline}</span>
        <Pill tone={pill[state][1]}>{pill[state][0]}</Pill>
      </div>

      {on.length ? (
        <>
          <p className="mt-1 text-sm text-[var(--color-fg)]">
            Your {on.map((k) => k.label.toLowerCase().replace("whatsapp", "WhatsApp")).join(" and ")}{" "}
            {on.length > 1 ? "are" : "is"} triaged as it arrives.{" "}
            {canEdit
              ? "Edit the triage skills to change how messages are sorted and escalated."
              : "Only an owner or admin can change the triage skills."}
          </p>
          <ul className="mt-2 space-y-2">
            {on.map((k) => (
              <li key={k.kind} data-kind={k.kind} data-state={k.status} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 font-medium">{k.label} triage</span>
                  <Pill tone="success">On</Pill>
                </div>
                <ul className="mt-1 divide-y divide-[var(--color-border)]">
                  {kindFiles(k).map((f) => (
                    <li key={f.path} data-component="TriageSkillFile" data-file={f.path} className="flex items-center gap-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <span className="block font-mono text-xs text-[var(--color-fg)]">{f.name}</span>
                        <span className="block truncate font-mono text-[11px] text-[var(--color-muted)]" title={f.path}>
                          {f.path}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        aria-label={`${canEdit ? "Edit" : "View"} ${k.label} ${f.name}`}
                        onClick={() => setOpen({ kind: k.kind, file: f, tab: "file" })}
                      >
                        {canEdit ? "Edit" : "View"}
                      </button>
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        aria-label={`History of ${k.label} ${f.name}`}
                        onClick={() => setOpen({ kind: k.kind, file: f, tab: "history" })}
                      >
                        History
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {partly.length ? (
        <ul className="mt-2 space-y-2">
          {partly.map((k) => (
            <li key={k.kind} data-kind={k.kind} data-state={k.status} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{k.label} triage</span>
                <Pill tone="warning">Partly set up</Pill>
              </div>
              <ul className="mt-1 list-disc pl-5 text-[var(--color-fg)]">
                {k.missing.map((m) => (
                  <li key={m} data-missing={m}>
                    {missingText(k.kind, m)}
                  </li>
                ))}
              </ul>
              {k.setup_links[0] ? (
                <Link href={k.setup_links[0].href} className="mt-1 inline-block text-[var(--color-accent)] underline">
                  Fix it in Settings → {k.setup_links[0].label} →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {off.length ? (
        <div className="mt-2" data-testid="triage-reminder">
          <p className="text-sm text-[var(--color-fg)]">
            {on.length || partly.length ? "Triage can also cover:" : "Aquarium can triage your incoming messages: it sorts them, flags what's urgent and adds to-dos. Nothing is being triaged for you yet."}
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {off.map((k) => (
              <li key={k.kind} data-kind={k.kind} data-state={k.status} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex-1">{k.label} triage</span>
                {k.setup_links.map((l) => (
                  <Link key={l.href + l.label} href={l.href} className="text-[var(--color-accent)] underline">
                    {l.label} →
                  </Link>
                ))}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-[var(--color-muted)]">Set up in Settings → In &amp; Out.</p>
        </div>
      ) : null}

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Triage skills are shared by every profile on this box and apply from the next message triaged. They aren&apos;t part of{" "}
        {profile}&apos;s skills list.
      </p>

      {open ? (
        <TriageFileSheet
          key={`${open.kind}:${open.file.path}`}
          profile={profile}
          open={open}
          canEdit={canEdit}
          onTab={(tab) => setOpen({ ...open, tab })}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function TriageFileSheet({
  profile,
  open,
  canEdit,
  onTab,
  onClose,
}: {
  profile: string;
  open: Open;
  canEdit: boolean;
  onTab(tab: Open["tab"]): void;
  onClose(): void;
}) {
  const [file, setFile] = useState<TriageSkillFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<TriageSkillFileHistory | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rev, setRev] = useState(0);
  const qs = new URLSearchParams({ kind: open.kind, path: open.file.path, profile }).toString();

  useEffect(() => {
    let live = true;
    getJson<TriageSkillFileContent>(`/api/triage/skill-file?${qs}`)
      .then((d) => {
        if (!live) return;
        setFile(d);
        setDraft(d.content);
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [qs]);

  useEffect(() => {
    if (open.tab !== "history") return;
    let live = true;
    getJson<TriageSkillFileHistory>(`/api/triage/skill-file/history?${qs}`)
      .then((d) => live && setHistory(d))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [qs, open.tab, rev]);

  const editable = canEdit && file?.can_edit === true;

  async function save() {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await sendJson(`/api/triage/skill-file?profile=${encodeURIComponent(profile)}`, "PUT", {
        kind: open.kind,
        path: open.file.path,
        content: draft,
      });
      setFile({ ...file, content: draft });
      setSaved("Saved as a new version. The next message triaged uses it.");
      setRev((r) => r + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const versions = Array.isArray(history?.versions) ? history.versions : [];
  const shown = versions.find((v) => v.id === picked) ?? versions[0];
  const footer =
    editable && open.tab === "file" ? (
      <>
        <span className="flex-1" />
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={saving || draft === file?.content}
          onClick={() => void save()}
        >
          Save
        </button>
      </>
    ) : (
      <>
        <span className="flex-1" />
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Close
        </button>
      </>
    );

  return (
    <Sheet
      component="TriageSkillEditor"
      wide
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{open.file.name}</span>
          <Pill tone="warning">◆ Triage</Pill>
        </span>
      }
      onClose={onClose}
      footer={footer}
    >
      <div className="space-y-3 text-sm">
        {!editable ? (
          <p data-testid="triage-read-only" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
            Read-only: triage skills are shared by everyone on this box, so only an owner or admin can change them.
          </p>
        ) : null}
        <div role="tablist" className="flex gap-0.5 border-b border-[var(--color-border)]">
          {(
            [
              ["file", "File"],
              ["history", "History"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={open.tab === tab}
              className={`-mb-px border-b-2 px-3 py-2 ${
                open.tab === tab ? "border-[var(--color-accent)] font-semibold" : "border-transparent text-[var(--color-muted)]"
              }`}
              onClick={() => onTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        {saved ? <p role="status" className="text-xs text-[var(--color-muted)]">{saved}</p> : null}
        {open.tab === "file" ? (
          <>
            <textarea
              aria-label={open.file.name}
              className={`${inputClass} min-h-[18rem] font-mono text-xs`}
              readOnly={!editable}
              value={file ? draft : ""}
              placeholder={file ? "" : "Loading…"}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="text-xs text-[var(--color-muted)]">
              Read by the {open.kind} triage pipeline from <span className="font-mono">{open.file.path}</span> (triage.skills_dirs).
              {editable ? " Saving makes a new version; the next message triaged uses it." : ""}
            </p>
          </>
        ) : !history ? (
          <p className="text-[var(--color-muted)]">Loading history…</p>
        ) : versions.length === 0 ? (
          <p data-testid="triage-history-empty" className="text-[var(--color-muted)]">
            No saved versions yet. The file is as installed; the first edit keeps a copy of it.
          </p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <ul className="flex shrink-0 flex-col gap-0.5 sm:w-56">
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    type="button"
                    data-version={v.id}
                    className={`w-full rounded-lg px-3 py-1.5 text-left text-xs ${
                      v.id === shown?.id ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"
                    }`}
                    onClick={() => setPicked(v.id)}
                  >
                    <span className="block font-medium">
                      v{versions.length - i} · {new Date(v.at * 1000).toLocaleString()}
                    </span>
                    <span className="block">
                      {v.author === "system" ? "As installed" : v.author.replace(/^user:/, "")} · {v.message}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <pre data-testid="triage-version-content" className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] p-2 font-mono text-xs">
              {shown?.content}
            </pre>
          </div>
        )}
      </div>
    </Sheet>
  );
}

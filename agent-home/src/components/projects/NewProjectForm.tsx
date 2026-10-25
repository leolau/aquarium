"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { CategoryPicker, findCategory } from "@/components/projects/categories/CategoryPicker";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";
import { friendlyError } from "@/components/projects/errors";
import { FileDropZone } from "@/components/projects/inputs/FileDropZone";
import { FileQueueList } from "@/components/projects/inputs/FileQueueList";
import {
  FILE_ROLES,
  memoryLink,
  memoryTitle,
  suggestionQuery,
  type LinkEntry,
} from "@/components/projects/inputs/inputKinds";
import { LinkNoteInput } from "@/components/projects/inputs/LinkNoteInput";
import { MemoryPicker } from "@/components/projects/inputs/MemoryPicker";
import type { UploadFn } from "@/components/projects/inputs/uploadProjectFile";
import { useUploadQueue } from "@/components/projects/inputs/useUploadQueue";
import {
  DEFAULT_PLAN_CHOICE,
  PLAN_CHOICES,
  WIZARD_STEPS,
  canLeaveInputs,
  hasAnyInput,
  inputsSummary,
  planChoice,
  planLanding,
  stepLabel,
  type PlanChoice,
  type WizardStep,
} from "@/components/projects/inputs/wizard";
import {
  newIdempotencyKey,
  sendProjectAction,
  useProjectAction,
} from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { useAction } from "@/lib/use-action";
import type { MemoryRow, ProjectAutonomy, ProjectCadence } from "@/types";

/** The §2.2 mandatory fields a 422's `missing` list can name. */
type MandatoryField = "goal" | "description" | "outputs" | "host_profile";

/** Each choice says what the user will see happen, not what the enum means. */
export const CADENCES: { value: ProjectCadence; label: string; explain: string }[] = [
  {
    value: "one_off",
    label: "One-off — finish it once",
    explain:
      "You start each run yourself. Once every required output is accepted the project offers to close.",
  },
  {
    value: "repeatable",
    label: "Repeatable — runs on a schedule",
    explain:
      "Runs fire on a schedule you set in Settings after creating (nothing fires until you do); each run delivers the outputs again.",
  },
  {
    value: "standing",
    label: "Standing — an ongoing duty",
    explain:
      "Never “done”: cards keep arriving and progress is measured by recent deliveries, not a finish line.",
  },
];

export const AUTONOMIES: { value: ProjectAutonomy; label: string; explain: string }[] = [
  {
    value: "manual",
    label: "Manual — never runs itself",
    explain:
      "Nothing happens without you: every step waits in triage until you make it ready, a schedule never fires, and only Run now starts a run.",
  },
  {
    value: "supervised",
    label: "Supervised — runs, then reports",
    explain:
      "The agent works through the plan and pauses at checkpoints for you; you accept the outputs.",
  },
  {
    value: "autonomous",
    label: "Autonomous — runs and decides",
    explain:
      "The agent promotes its own steps and runs to the end without stopping; irreversible acts still ask for approval and you still accept the outputs.",
  },
];

type PointerStatus = "waiting" | "sending" | "done" | "failed";

/** A memory or link/note to attach once the project exists. */
interface PendingPointer {
  id: string;
  title: string;
  kindLabel: string;
  payload: { kind: string; ref: string; label: string };
}

/**
 * The four-step create form (§13):
 *
 * 1. **What** — goal, description and at least one output (mandatory).
 * 2. **Inputs** — files (each a template to match or a reference to read),
 *    memories and links/notes; must be answered — add something or skip.
 * 3. **How it runs** — cadence and autonomy (defaults pre-selected).
 * 4. **Review & plan** — a summary, the plan choice, and Create.
 *
 * Nothing is created before step 4. Create then runs once: the project is
 * POSTed (with a lock and a fixed key), each file is uploaded once to
 * `/files/upload`, each memory/link is linked once, and only then does the
 * agent ask its scope questions (the default) or draft the plan. If an
 * input fails the project still exists: the failures show with Retry (create is never repeated, finished uploads are
 * never re-sent), or the user can go on to the project and add it there.
 *
 * A refusal maps onto the field that is blank — never a toast — and what
 * was typed survives it: the inputs are state, so a 422 costs nothing.
 */
export function NewProjectForm({
  servingProfile,
  upload,
  memoryFetch,
}: {
  servingProfile: string;
  /** Test seam: the file upload transport. */
  upload?: UploadFn;
  /** Test seam: the memory search transport. */
  memoryFetch?: typeof fetch;
}) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(1);
  const [goal, setGoal] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const categories = useProjectCategories();
  const chosenCategory = findCategory(categories.categories, categoryId);
  const [outputs, setOutputs] = useState<string[]>([""]);
  const [cadence, setCadence] = useState<ProjectCadence>("one_off");
  const [autonomy, setAutonomy] = useState<ProjectAutonomy>("supervised");
  const [plan, setPlan] = useState<PlanChoice>(DEFAULT_PLAN_CHOICE);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<MandatoryField, string>>>({});

  // ── Inputs (held locally until the project exists) ──
  const queue = useUploadQueue({ upload });
  const [memories, setMemories] = useState<Map<string, MemoryRow>>(() => new Map());
  const [entries, setEntries] = useState<(LinkEntry & { id: string })[]>([]);
  const [skipped, setSkipped] = useState(false);
  const [pointerStatus, setPointerStatus] = useState<Record<string, PointerStatus>>({});
  const pointerKeys = useRef(new Map<string, string>());

  // ── Create sequencing ──
  const create = useProjectAction<CreateAnswer>();
  const submitLock = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  // The scope questions are asked once per created project, with one key.
  const clarifyKey = useRef<string | null>(null);
  const clarifyAsked = useRef(false);

  const tally = { files: queue.items.length, memories: memories.size, links: entries.length };
  const inputsAnswered = canLeaveInputs(tally, skipped);

  const pointers: PendingPointer[] = [
    ...Array.from(memories.values()).map((row) => ({
      id: `memory:${row.id}`,
      title: memoryTitle(row),
      kindLabel: "Memory",
      payload: memoryLink(row),
    })),
    ...entries.map((entry) => ({
      id: entry.id,
      title: entry.label,
      kindLabel: entry.kind === "url" ? "Link" : "Note",
      payload: { kind: entry.kind, ref: entry.ref, label: entry.label },
    })),
  ];

  const validateStep1 = (): boolean => {
    const next: Partial<Record<MandatoryField, string>> = {};
    if (!goal.trim()) next.goal = "A project needs a goal sentence.";
    if (!description.trim()) {
      next.description = "A project needs a description.";
    }
    if (!outputs.some((title) => title.trim())) {
      next.outputs = "A project declares at least one output.";
    }
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  /** Link every memory/link not yet attached; one fixed key per pointer. */
  const attachPointers = async (slug: string): Promise<boolean> => {
    const todo = pointers.filter((p) => pointerStatus[p.id] !== "done");
    const results = await Promise.all(
      todo.map(async (pointer) => {
        let key = pointerKeys.current.get(pointer.id);
        if (!key) {
          key = newIdempotencyKey();
          pointerKeys.current.set(pointer.id, key);
        }
        setPointerStatus((prev) => ({ ...prev, [pointer.id]: "sending" }));
        const res = await sendProjectAction(
          `/api/projects/${encodeURIComponent(slug)}/links`,
          key,
          { method: "POST", body: pointer.payload },
        );
        setPointerStatus((prev) => ({ ...prev, [pointer.id]: res.ok ? "done" : "failed" }));
        return res.ok;
      }),
    );
    return results.every(Boolean);
  };

  /** Start the scope questions or the agent draft (if chosen) and land on the project page. */
  const finish = async (slug: string) => {
    // The project exists but cannot run until a plan is active. Always land
    // on its page: the Scope tab when the agent asks first, else the Plan
    // tab. Either server-side job starts after the inputs are attached, so
    // the agent reads them. A refused job is not a failed create — the
    // project exists either way, and its Scope/Plan tab can start it again.
    if (plan === "scope") {
      if (!clarifyAsked.current) {
        clarifyAsked.current = true;
        clarifyKey.current ??= newIdempotencyKey();
        await sendProjectAction(
          `/api/projects/${encodeURIComponent(slug)}/clarify/questions`,
          clarifyKey.current,
          { method: "POST", body: {} },
        );
      }
    } else if (plan === "agent") {
      await fetch(`/api/projects/${encodeURIComponent(slug)}/playbook/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    router.push(planLanding(slug, plan));
  };

  const submit = async () => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let slug = createdSlug;
      if (!slug) {
        setFieldErrors({});
        const res = await create.run("/api/projects", {
          skipRefresh: true,
          body: {
            goal: goal.trim(),
            description: description.trim(),
            name: name.trim() || undefined,
            host_profile: servingProfile,
            outputs: outputs
              .map((title) => title.trim())
              .filter(Boolean)
              .map((title) => ({ title })),
            cadence,
            autonomy,
            ...(chosenCategory ? { category_id: chosenCategory.id } : {}),
          },
        });
        if (!res) return;
        if (!res.ok || !res.data?.slug) {
          showRefusal(res.status, res.data, res.error);
          return;
        }
        slug = res.data.slug;
        setCreatedSlug(slug);
      }
      const [filesOk, pointersOk] = await Promise.all([
        queue.uploadPending(slug),
        attachPointers(slug),
      ]);
      if (!filesOk || !pointersOk) {
        setPartial(true);
        return;
      }
      await finish(slug);
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const showRefusal = (status: number, data: CreateAnswer | null, fallback: string | null) => {
    if (status === 0) {
      setError("Could not reach the server.");
      return;
    }
    // The 422 names the blank field(s) — the BFF pre-check and the widened
    // bridge both carry the `missing` list at the top level beside the
    // string `detail` (U3) — map it onto the form.
    const missing = Array.isArray(data?.missing) ? (data.missing as MandatoryField[]) : null;
    if (missing && missing.length > 0) {
      const next: Partial<Record<MandatoryField, string>> = {};
      for (const field of missing) {
        next[field] = "This field is mandatory.";
      }
      setFieldErrors(next);
      setError(typeof data?.detail === "string" && data.detail ? data.detail : null);
      if (missing.includes("goal") || missing.includes("description") || missing.includes("outputs")) {
        setStep(1);
      }
      return;
    }
    setError(
      friendlyError(
        { status, detail: data?.detail },
        fallback ?? "That didn't go through — check the fields and try again.",
      ),
    );
  };

  const goNext = () => {
    setError(null);
    if (step === 1) {
      if (validateStep1()) setStep(2);
    } else if (step === 2) {
      if (inputsAnswered) setStep(3);
    } else if (step === 3) {
      setStep(4);
    } else {
      void submit();
    }
  };

  const inputClass = (invalid: boolean) =>
    `w-full rounded-xl border bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] ${
      invalid ? "border-red-400" : "border-[var(--color-border)]"
    }`;

  const busy = submitting || create.busy;
  const created = createdSlug !== null;

  const primaryLabel =
    step === 1
      ? "Next: inputs"
      : step === 2
        ? inputsAnswered
          ? "Next: how it runs"
          : "Add something or skip"
        : step === 3
          ? "Next: review"
          : partial
            ? "Retry failed inputs"
            : planChoice(plan).create;

  const pendingLabel = created ? "Attaching inputs…" : "Creating the project…";

  const { run: finishOnce, pending: finishing } = useAction(finish);

  return (
    <BusyRegion busy={busy} label={pendingLabel}>
      <form
        data-component="NewProjectForm"
        data-step={step}
        className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          goNext();
        }}
      >
        <header data-component="WizardStepHeader" className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Step {step} of 4 · {stepLabel(step)}
          </p>
          <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {WIZARD_STEPS.map((s) => (
              <li
                key={s.step}
                aria-current={s.step === step ? "step" : undefined}
                className={
                  s.step === step
                    ? "font-semibold text-[var(--color-accent)]"
                    : s.step < step
                      ? "text-[var(--color-text)]"
                      : "text-[var(--color-muted)]"
                }
              >
                {s.step} {s.label}
              </li>
            ))}
          </ol>
        </header>

        {step === 1 ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span>Goal — what success means *</span>
              <input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Ship the Monday digest to every subscriber"
                className={inputClass(Boolean(fieldErrors.goal))}
              />
              {fieldErrors.goal ? (
                <span role="alert" className="text-xs text-red-400">
                  {fieldErrors.goal}
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>Description — the brief the agent works from *</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="A weekly digest compiled from arrivals and emailed each Monday…"
                className={inputClass(Boolean(fieldErrors.description))}
              />
              {fieldErrors.description ? (
                <span role="alert" className="text-xs text-red-400">
                  {fieldErrors.description}
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>
                Name <span className="text-[var(--color-muted)]">(optional — derived from the goal)</span>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Monday digest"
                className={inputClass(false)}
              />
            </label>

            <CategoryPicker
              id="new-project-category"
              label="Category (optional)"
              categories={categories.categories}
              value={categoryId}
              onChange={setCategoryId}
              disabled={categories.loading && categories.categories.length === 0}
            />

            <div className="flex flex-col gap-1 text-sm">
              <span>Outputs — what it delivers * </span>
              {outputs.map((title, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    value={title}
                    onChange={(e) =>
                      setOutputs((prev) =>
                        prev.map((t, i) => (i === index ? e.target.value : t)),
                      )
                    }
                    placeholder="The Monday digest email"
                    className={inputClass(Boolean(fieldErrors.outputs))}
                  />
                  {outputs.length > 1 ? (
                    <button
                      type="button"
                      aria-label={`Remove output ${index + 1}`}
                      onClick={() =>
                        setOutputs((prev) => prev.filter((_t, i) => i !== index))
                      }
                      className="rounded-xl border border-[var(--color-border)] px-3 text-sm text-[var(--color-muted)]"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              {fieldErrors.outputs ? (
                <span role="alert" className="text-xs text-red-400">
                  {fieldErrors.outputs}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setOutputs((prev) => [...prev, ""])}
                className="self-start rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs"
              >
                Add another output
              </button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <div data-component="WizardInputsStep" className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold">
                Do you have anything the agent should use?
              </h2>
              <p className="text-xs text-[var(--color-muted)]">
                Projects with source material get it right first time. Add
                templates, earlier agreements, notes, or things you&rsquo;ve
                told the agent before.
              </p>
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">📎 Files</h3>
              <FileDropZone
                hint="Drop files here"
                onFiles={(picked) => {
                  queue.add(picked);
                  setSkipped(false);
                }}
              />
              <p className="text-xs text-[var(--color-muted)]">
                For each file, say whether it is a{" "}
                {FILE_ROLES.map((r) => r.label.toLowerCase()).join(" or a ")}.
              </p>
              <FileQueueList
                items={queue.items}
                onRole={queue.setRole}
                onRemove={queue.remove}
                waitingCopy="Uploads when you create the project"
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">🧠 Memory</h3>
              <p className="-mt-1 text-xs text-[var(--color-muted)]">Things the agent already knows</p>
              <MemoryPicker
                suggestFrom={suggestionQuery(goal, description)}
                selected={memories}
                fetchImpl={memoryFetch}
                onToggle={(row, checked) => {
                  setMemories((prev) => {
                    const next = new Map(prev);
                    if (checked) next.set(row.id, row);
                    else next.delete(row.id);
                    return next;
                  });
                  if (checked) setSkipped(false);
                }}
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">🔗 Links &amp; notes</h3>
              {entries.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm"
                    >
                      <span aria-hidden>{entry.kind === "url" ? "🔗" : "✎"}</span>
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.label}`}
                        onClick={() => setEntries((prev) => prev.filter((e) => e.id !== entry.id))}
                        className="text-[var(--color-muted)]"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <LinkNoteInput
                onAdd={(entry) => {
                  setEntries((prev) =>
                    prev.some((e) => e.kind === entry.kind && e.ref === entry.ref)
                      ? prev
                      : [...prev, { ...entry, id: newIdempotencyKey() }],
                  );
                  setSkipped(false);
                }}
              />
            </section>
          </div>
        ) : null}

        {step === 3 ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span>Cadence</span>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ProjectCadence)}
                aria-describedby="new-project-cadence-help"
                className={inputClass(false)}
              >
                {CADENCES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span
                id="new-project-cadence-help"
                className="text-xs text-[var(--color-muted)]"
              >
                {CADENCES.find((option) => option.value === cadence)?.explain}
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>Autonomy</span>
              <select
                value={autonomy}
                onChange={(e) => setAutonomy(e.target.value as ProjectAutonomy)}
                aria-describedby="new-project-autonomy-help"
                className={inputClass(false)}
              >
                {AUTONOMIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span
                id="new-project-autonomy-help"
                className="text-xs text-[var(--color-muted)]"
              >
                {AUTONOMIES.find((option) => option.value === autonomy)?.explain}
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>Host profile</span>
              <input
                value={servingProfile}
                readOnly
                aria-readonly="true"
                className="w-full cursor-default rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]"
              />
              <span className="text-xs text-[var(--color-muted)]">
                Fixed to the profile serving this page — the record lives
                where you can see it.
              </span>
            </label>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <p className="-mt-2 text-xs text-[var(--color-muted)]">
              Nothing is created until you press the button at the bottom;
              afterwards you land on the project&rsquo;s own page.
            </p>
            <dl data-component="WizardSummary" className="flex flex-col gap-2 text-sm">
              <div>
                <dt className="text-xs text-[var(--color-muted)]">Goal</dt>
                <dd>{goal.trim()}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted)]">Outputs</dt>
                <dd>
                  <ul className="list-disc pl-5">
                    {outputs
                      .map((t) => t.trim())
                      .filter(Boolean)
                      .map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-muted)]">How it runs</dt>
                <dd>
                  {CADENCES.find((c) => c.value === cadence)?.label} ·{" "}
                  {AUTONOMIES.find((a) => a.value === autonomy)?.label}
                </dd>
              </div>
              {chosenCategory ? (
                <div>
                  <dt className="text-xs text-[var(--color-muted)]">Category</dt>
                  <dd>{chosenCategory.name}</dd>
                </div>
              ) : null}
              <div data-component="WizardInputsSummary">
                <dt className="text-xs text-[var(--color-muted)]">Inputs</dt>
                <dd className="flex flex-col gap-1.5">
                  {hasAnyInput(tally) ? (
                    <>
                      <span>{inputsSummary(tally)}</span>
                      <FileQueueList
                        items={queue.items}
                        onRetry={createdSlug ? (id) => void queue.retry(id, createdSlug) : undefined}
                        waitingCopy="Uploads when you create the project"
                      />
                      {pointers.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {pointers.map((p) => {
                            const status = pointerStatus[p.id] ?? "waiting";
                            return (
                              <li key={p.id} data-status={status} className="text-xs">
                                <span className="text-[var(--color-muted)]">{p.kindLabel}:</span>{" "}
                                {p.title}
                                {status === "done" ? (
                                  <span className="text-emerald-500"> ✓</span>
                                ) : status === "failed" ? (
                                  <span className="text-red-400"> ✗ not attached</span>
                                ) : status === "sending" ? (
                                  <span className="text-[var(--color-muted)]"> attaching…</span>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-[var(--color-muted)]">
                      No inputs — you can add files and memories from the
                      project&rsquo;s Inputs tab later.
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            {created ? null : (
              <fieldset
                data-component="PlanChoice"
                className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3 text-sm"
              >
                <legend className="px-1 text-sm">Plan — a run needs one</legend>
                {PLAN_CHOICES.map((choice) => (
                  <label key={choice.value} className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="plan"
                      value={choice.value}
                      checked={plan === choice.value}
                      onChange={() => setPlan(choice.value)}
                      className="mt-1"
                    />
                    <span>
                      {choice.label}
                      <span className="block text-xs text-[var(--color-muted)]">
                        {choice.explain}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {partial && createdSlug ? (
              <div
                role="alert"
                data-component="WizardPartialInputs"
                className="flex flex-col gap-2 rounded-xl border border-red-400/50 p-3 text-sm"
              >
                <p>
                  The project was created, but some inputs didn&rsquo;t attach.
                  Retry them, or go to the project and add them from its
                  Inputs tab.
                </p>
                <ActionButton
                  busy={finishing}
                  pendingLabel="Opening…"
                  disabled={busy}
                  onClick={() => void finishOnce(createdSlug)}
                  className="self-start text-xs underline disabled:opacity-50"
                >
                  Go to the project without them
                </ActionButton>
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          {step > 1 && !created ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep((s) => (s - 1) as WizardStep);
              }}
              className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
            >
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {step === 2 && !hasAnyInput(tally) ? (
              <button
                type="button"
                onClick={() => {
                  setSkipped(true);
                  setStep(3);
                }}
                className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm"
              >
                I have no inputs — skip
              </button>
            ) : null}
            <ActionButton
              type="submit"
              busy={busy}
              pendingLabel={pendingLabel}
              disabled={step === 2 && !inputsAnswered}
              className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {primaryLabel}
            </ActionButton>
          </div>
        </div>
      </form>
    </BusyRegion>
  );
}

interface CreateAnswer {
  slug?: string;
  detail?: unknown;
  error?: string;
  missing?: unknown;
}

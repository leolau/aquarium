"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { LockIcon } from "@/components/ui/icons";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import {
  ADMIN_SKILLS_EDIT_DENIED,
  changedSkillActions,
  TOOL_SKILL_ACTIONS,
  type SkillAction,
  type SkillActionInfo,
  type SkillPermissionsChange,
  type SkillRolePermissions,
  type SkillsAccessResponse,
} from "@/lib/skills/permissions";

/**
 * Settings → Skills permissions: the five skill actions (rows) for each role
 * (columns) in this profile. The owner column is locked on; only the owner
 * may change the admin column. The server normalises implications (manage ⇒
 * view, …) and the grid shows what it sends back. `use` and `agent_edit` are
 * the same switches as the Skills tools in Tools & Integrations.
 */

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function Switch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => unknown;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => void onToggle()}
      className="inline-flex h-11 w-12 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative block h-6 w-11 rounded-full transition-colors ${
          on ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-[var(--color-fg)] transition-all ${
            on ? "left-[1.375rem]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function RoleHeader({ role, saving }: { role: SkillRolePermissions; saving: boolean }) {
  return (
    <th
      scope="col"
      data-role={role.role}
      className="min-w-[5.5rem] px-2 py-3 text-center align-bottom font-medium"
      aria-describedby={role.role === "admin" && !role.editable ? "skills-perm-admin-hint" : undefined}
    >
      <span className="flex flex-col items-center gap-1">
        <span className="flex items-center gap-1">
          {role.locked || !role.editable ? (
            <LockIcon size={14} className="text-[var(--color-muted)]" />
          ) : null}
          {role.label}
        </span>
        {saving ? (
          <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-muted)]" role="status">
            <Spinner /> Saving…
          </span>
        ) : role.locked ? (
          <span className="text-xs font-normal text-[var(--color-muted)]">Always on</span>
        ) : (
          <Pill tone={role.customised ? "accent" : "muted"}>{role.customised ? "customised" : "default"}</Pill>
        )}
      </span>
    </th>
  );
}

function ActionLabel({ action }: { action: SkillActionInfo }) {
  return (
    <th
      scope="row"
      className="sticky left-0 z-10 w-40 max-w-[11rem] bg-[var(--color-surface)] px-3 py-2 text-left align-middle font-normal sm:w-auto sm:max-w-none"
    >
      <span className="block text-sm font-medium">{action.label}</span>
      <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{action.description}</span>
      {TOOL_SKILL_ACTIONS.includes(action.key) ? (
        <span className="mt-1 inline-block">
          <Pill tone="muted">new chats</Pill>
        </span>
      ) : null}
    </th>
  );
}

function labelOf(actions: SkillActionInfo[], key: SkillAction): string {
  return actions.find((a) => a.key === key)?.label ?? key;
}

export function SkillsPermissionsSection() {
  const [data, setData] = useState<SkillsAccessResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  // A ref, not state: two taps in the same frame must not both get through.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/access/skills", { cache: "no-store" });
        if (!res.ok) throw new Error(await detailOf(res));
        const body = (await res.json()) as SkillsAccessResponse;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(role: SkillRolePermissions, change: SkillPermissionsChange, toggled?: SkillAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(role.role);
    setErrors((e) => ({ ...e, [role.role]: null }));
    setNotes((n) => ({ ...n, [role.role]: null }));
    try {
      const res = await fetch(`/api/access/skills/${encodeURIComponent(role.role)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) throw new Error(await detailOf(res));
      const body = (await res.json()) as SkillsAccessResponse;
      setData(body);
      const after = body.roles.find((r) => r.role === role.role);
      if (toggled && after) {
        const implied = changedSkillActions(role.actions, after.actions).filter((k) => k !== toggled);
        const on = implied.filter((k) => after.actions[k]).map((k) => labelOf(body.actions, k));
        const off = implied.filter((k) => !after.actions[k]).map((k) => labelOf(body.actions, k));
        const parts = [
          on.length ? `Also turned on: ${on.join(", ")}.` : "",
          off.length ? `Also turned off: ${off.join(", ")}.` : "",
        ].filter(Boolean);
        if (parts.length) setNotes((n) => ({ ...n, [role.role]: `${role.label}: ${parts.join(" ")}` }));
      }
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [role.role]: `Couldn't save ${role.label.toLowerCase()}: ${err instanceof Error ? err.message : "unknown error"}`,
      }));
    } finally {
      inFlight.current = false;
      setSaving(null);
    }
  }

  function toggle(role: SkillRolePermissions, key: SkillAction) {
    if (role.locked || !role.editable || inFlight.current) return;
    void save(role, { actions: { [key]: !role.actions[key] } }, key);
  }

  const adminLocked = data?.roles.some((r) => r.role === "admin" && !r.editable) ?? false;
  const messages = data
    ? data.roles.flatMap((r) => [
        ...(errors[r.role] ? [{ key: `e-${r.role}`, tone: "danger" as const, text: errors[r.role]! }] : []),
        ...(notes[r.role] ? [{ key: `n-${r.role}`, tone: "muted" as const, text: notes[r.role]! }] : []),
      ])
    : [];

  return (
    <section data-component="SkillsPermissionsSection" className="mt-2">
      <h2 className="text-sm font-semibold">Skills permissions</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        What each role in this profile may do with skills. Some switches need another one: managing skills or
        opening the Skills Lab also lets that role see skills, and asking the agent to edit skills also lets it use
        them.
      </p>

      {loadError ? (
        <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          Couldn&apos;t load skills permissions ({loadError}).
        </div>
      ) : data === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-[var(--color-muted)]" role="status">
          <Spinner /> Loading…
        </p>
      ) : (
        <>
          <div
            data-component="SkillsPermissionsGrid"
            className="mt-3 overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <caption className="sr-only">What each role may do with skills</caption>
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-[var(--color-surface)] px-3 py-3 text-left text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]"
                  >
                    Action
                  </th>
                  {data.roles.map((r) => (
                    <RoleHeader key={r.role} role={r} saving={saving === r.role} />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {data.actions.map((a) => (
                  <tr key={a.key} data-action={a.key}>
                    <ActionLabel action={a} />
                    {data.roles.map((r) => (
                      <td key={r.role} className="px-2 py-2 text-center align-middle">
                        <Switch
                          on={r.actions[a.key]}
                          label={`${r.label}: ${a.label}`}
                          disabled={r.locked || !r.editable || saving !== null}
                          onToggle={() => toggle(r, a.key)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--color-border)]">
                  <th scope="row" className="sticky left-0 z-10 bg-[var(--color-surface)] px-3 py-2">
                    <span className="sr-only">Reset</span>
                  </th>
                  {data.roles.map((r) => (
                    <td key={r.role} className="px-2 py-2 text-center">
                      {!r.locked && r.editable && r.customised ? (
                        <ActionButton
                          disabled={saving !== null}
                          onAction={() => save(r, { reset: true })}
                          aria-label={`Reset ${r.label.toLowerCase()} to default`}
                          className="rounded-lg bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                        >
                          Reset to default
                        </ActionButton>
                      ) : null}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          {adminLocked ? (
            <p id="skills-perm-admin-hint" className="mt-2 flex items-center gap-1 text-xs text-[var(--color-muted)]">
              <LockIcon size={12} /> {ADMIN_SKILLS_EDIT_DENIED}
            </p>
          ) : null}
          {messages.map((m) => (
            <p
              key={m.key}
              role={m.tone === "danger" ? "alert" : "status"}
              className={`mt-2 text-xs ${m.tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}
            >
              {m.text}
            </p>
          ))}
          <p data-note="tool-rows" className="mt-3 text-xs text-[var(--color-muted)]">
            Rows marked “new chats” change the agent&apos;s tools, so they apply to new chats; chats that are already
            open keep their tools. They are the same switches as the Skills tools under Tools &amp; Integrations → What
            each role can use. The other rows apply straight away.
          </p>
        </>
      )}
    </section>
  );
}

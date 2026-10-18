"use client";

import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import type { RoleLimit, RoleLimitsResponse, RoleToolGroup } from "@/types";

/**
 * Settings → Tools & Integrations → "What each role can use". Shows, per role,
 * which tool groups the agent may use and which files it may touch, read from
 * `access.roles` in config.yaml (or the built-in defaults). The owner and
 * admins can tick groups on/off inline; everyone else sees it read-only.
 */

type Pending = { role: RoleLimit; group: RoleToolGroup } | null;

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function readable(tool: string): string {
  return tool.replace(/_/g, " ");
}

function GroupRow({
  role,
  group,
  disabled,
  onToggle,
}: {
  role: RoleLimit;
  group: RoleToolGroup;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = group.state === "partial";
  }, [group.state]);
  const id = `role-${role.role}-${group.name}`;
  return (
    <li data-component="RoleGroupRow" className="flex items-start gap-3 py-2">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-50"
        checked={group.state === "allowed"}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`${role.label}: ${group.label}`}
      />
      <label htmlFor={id} className="min-w-0 flex-1 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className={group.state === "blocked" ? "text-[var(--color-muted)] line-through" : ""}>
            {group.label}
          </span>
          {group.risky ? <Pill tone="danger">risky</Pill> : null}
          {group.state === "blocked" ? <Pill tone="muted">blocked</Pill> : null}
          {group.state === "partial" ? <Pill tone="warning">partly blocked</Pill> : null}
        </span>
        {group.state === "partial" ? (
          <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
            Blocked: {group.blocked_tools.map(readable).join(", ")}
          </span>
        ) : null}
      </label>
    </li>
  );
}

function RoleCard({
  role,
  canEdit,
  saving,
  error,
  onToggle,
  onReset,
}: {
  role: RoleLimit;
  canEdit: boolean;
  saving: boolean;
  error: string | null;
  onToggle: (group: RoleToolGroup) => void;
  onReset: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const editable = canEdit && !role.locked;
  const notable = role.groups.filter((g) => g.state !== "allowed" || g.risky);
  const shown = showAll || role.locked ? role.groups : notable;
  return (
    <li
      data-component="RoleCard"
      aria-busy={saving}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{role.label}</span>
        {role.locked ? (
          <Pill tone="muted">always everything</Pill>
        ) : (
          <Pill tone={role.customised ? "accent" : "muted"}>
            {role.customised ? "customised" : "default"}
          </Pill>
        )}
        {saving ? (
          <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]" role="status">
            <Spinner /> Saving…
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm">{role.summary}</p>
      {role.other_blocked_tools.length > 0 ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Also blocked: {role.other_blocked_tools.map(readable).join(", ")}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}

      {role.locked ? null : (
        <>
          <ul className="mt-2 divide-y divide-[var(--color-border)]">
            {shown.map((g) => (
              <GroupRow
                key={g.name}
                role={role}
                group={g}
                disabled={!editable || saving}
                onToggle={() => onToggle(g)}
              />
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            {notable.length < role.groups.length ? (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium"
              >
                {showAll ? "Show fewer" : `Show all ${role.groups.length} tool groups`}
              </button>
            ) : null}
            {editable && role.customised ? (
              <button
                type="button"
                disabled={saving}
                onClick={onReset}
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                Reset to defaults
              </button>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

export function RoleLimitsSection({ canEdit }: { canEdit: boolean }) {
  const [roles, setRoles] = useState<RoleLimit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [confirm, setConfirm] = useState<Pending>(null);
  // A ref, not state: two taps in the same frame must not both get through.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/access/roles", { cache: "no-store" });
        if (!res.ok) throw new Error(await detailOf(res));
        const body = (await res.json()) as RoleLimitsResponse;
        if (!cancelled) setRoles(body.roles);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(role: RoleLimit, change: { deny_tools: string[] } | { reset: true }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(role.role);
    setErrors((e) => ({ ...e, [role.role]: null }));
    try {
      const res = await fetch(`/api/access/roles/${encodeURIComponent(role.role)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) throw new Error(await detailOf(res));
      const body = (await res.json()) as RoleLimitsResponse;
      setRoles(body.roles);
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [role.role]: `Couldn't save: ${err instanceof Error ? err.message : "unknown error"}`,
      }));
    } finally {
      inFlight.current = false;
      setSaving(null);
    }
  }

  function applyToggle(role: RoleLimit, group: RoleToolGroup) {
    const blocked = new Set(role.blocked_tools);
    if (group.state === "allowed") group.tools.forEach((t) => blocked.add(t));
    else group.tools.forEach((t) => blocked.delete(t));
    void save(role, { deny_tools: [...blocked].sort() });
  }

  function toggle(role: RoleLimit, group: RoleToolGroup) {
    if (!canEdit || role.locked || inFlight.current) return;
    const unblockingRisky =
      group.risky && group.state !== "allowed" && role.role !== "admin";
    if (unblockingRisky) {
      setConfirm({ role, group });
      return;
    }
    applyToggle(role, group);
  }

  return (
    <section data-component="RoleLimitsSection" className="mt-6">
      <h2 className="text-sm font-semibold">What each role can use</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Untick a group to stop that role&apos;s assistant using it. Changes apply to new
        chats; chats that are already open keep their tools.
        {canEdit ? null : " Only the owner or an admin can change this."}
      </p>

      {loadError ? (
        <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          Couldn&apos;t load what each role can use ({loadError}).
        </div>
      ) : roles === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-[var(--color-muted)]" role="status">
          <Spinner /> Loading…
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {roles.map((r) => (
            <RoleCard
              key={r.role}
              role={r}
              canEdit={canEdit}
              saving={saving === r.role}
              error={errors[r.role] ?? null}
              onToggle={(g) => toggle(r, g)}
              onReset={() => void save(r, { reset: true })}
            />
          ))}
        </ul>
      )}

      {confirm ? (
        <ConfirmDialog
          title={`Let ${confirm.role.label.toLowerCase()} use ${confirm.group.label}?`}
          body={`This lets the assistant run any command for ${confirm.role.label.toLowerCase()}, so they could read or change any file the server can reach — not just their own folder.`}
          confirmLabel="Allow"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { role, group } = confirm;
            setConfirm(null);
            applyToggle(role, group);
          }}
        />
      ) : null}
    </section>
  );
}

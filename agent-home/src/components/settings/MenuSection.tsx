"use client";

/**
 * Settings → Menu (owner/admin): which launcher items each role sees. One tab
 * per role (admin, member, viewer), a switch per app, grouped like the Coral
 * launcher. Edits are a draft per role until Save. Home and Settings are
 * locked on; the owner always sees everything.
 * Hidden items are also refused by URL (see `lib/nav/menu-access.ts`).
 */
import { useEffect, useState } from "react";

import "@/components/coral/coral-apps";
import { getApps } from "@/components/coral/coral-registry";
import { CLUSTER_CATEGORIES, type AppManifest } from "@/components/coral/coral-types";
import { useAction } from "@/lib/use-action";
import { isLockedOff, LOCKED_APP_IDS, NAV_ROLES, type NavRole } from "@/lib/nav/menu-access";
import type { AgentHomeNav } from "@/types";

const ROLE_LABEL: Record<NavRole, string> = { admin: "Admin", member: "Member", viewer: "Viewer" };
const GROUP_LABEL: Record<string, string> = { workspace: "Workspace", system: "System" };

/** Launcher grouping: top-level apps first, then each cluster's members. */
function launcherGroups(): { id: string; label: string; apps: AppManifest[] }[] {
  const apps = [...getApps()].sort((a, b) => a.order - b.order);
  const inCluster = (a: AppManifest) => !!a.category && CLUSTER_CATEGORIES.includes(a.category);
  return [
    { id: "main", label: "Main", apps: apps.filter((a) => !inCluster(a)) },
    ...CLUSTER_CATEGORIES.map((c) => ({
      id: c,
      label: GROUP_LABEL[c] ?? c,
      apps: apps.filter((a) => a.category === c),
    })),
  ].filter((g) => g.apps.length > 0);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

export function MenuSection() {
  const [nav, setNav] = useState<AgentHomeNav | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<NavRole>("member");
  // Unsaved edits per role; a role without an entry shows the stored list.
  const [drafts, setDrafts] = useState<Partial<Record<NavRole, string[]>>>({});
  const [savedRole, setSavedRole] = useState<NavRole | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/menu")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail ?? "Couldn't load the menu settings.");
        if (!cancelled) setNav(body as AgentHomeNav);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const stored = nav?.roles?.[role] ?? [];
  const hidden = drafts[role] ?? stored;
  const dirty = !sameSet(hidden, stored);
  const readOnly = !nav?.roles;

  const toggle = (appId: string) => {
    if (readOnly || isLockedOff(role, appId) || LOCKED_APP_IDS.includes(appId)) return;
    const next = hidden.includes(appId) ? hidden.filter((id) => id !== appId) : [...hidden, appId];
    setSavedRole(null);
    setDrafts((prev) => ({ ...prev, [role]: next }));
  };

  const discard = () => {
    setError(null);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
  };

  const { run: save, pending: saving } = useAction(async () => {
    if (!nav?.roles || !dirty) return;
    const target = role;
    setError(null);
    try {
      const res = await fetch(`/api/settings/menu/${target}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the menu.");
      setNav(body as AgentHomeNav);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[target];
        return next;
      });
      setSavedRole(target);
    } catch (err) {
      setError((err as Error).message);
    }
  });

  return (
    <section data-section="menu" data-component="MenuSection" className="mt-6">
      <h2 className="text-sm font-semibold">Menu</h2>
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        Choose which menu items each role sees, then press Save. Hidden items are also blocked by
        link. Changes can take up to 30 seconds to reach everyone.
      </p>
      <ul className="mb-3 list-disc space-y-0.5 pl-4 text-xs text-[var(--color-muted)]">
        <li>
          <strong>Always shown</strong>: Home and Settings stay on for everyone, so nobody is
          locked out.
        </li>
        <li>
          <strong>Admins only</strong>: Profiles and Skills stay off for members and viewers,
          because only owners and admins can make changes there.
        </li>
        <li>
          {nav?.is_owner ? "You are the owner, so your" : "The owner's"} own menu always shows
          everything; these choices only change what admins, members and viewers see.
        </li>
      </ul>
      <div role="tablist" aria-label="Role" className="mb-3 flex gap-2">
        {NAV_ROLES.map((r) => {
          const unsaved = drafts[r] !== undefined && !sameSet(drafts[r]!, nav?.roles?.[r] ?? []);
          return (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={role === r}
              onClick={() => {
                setRole(r);
                setSavedRole(null);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                role === r
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              {ROLE_LABEL[r]}
              {unsaved ? <span aria-label=" (unsaved)"> •</span> : null}
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--color-danger,#b91c1c)]">
          {error}
        </p>
      ) : null}
      {!nav ? (
        error ? null : <p className="text-xs text-[var(--color-muted)]">Loading…</p>
      ) : (
        <div role="tabpanel" aria-label={`${ROLE_LABEL[role]} menu`} className="space-y-3">
          {launcherGroups().map((group) => (
            <div
              key={group.id}
              data-group={group.id}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <h3 className="mb-2 text-xs font-semibold text-[var(--color-muted)]">{group.label}</h3>
              <ul className="space-y-1">
                {group.apps.map((app) => {
                  const locked = LOCKED_APP_IDS.includes(app.id);
                  const lockedOff = isLockedOff(role, app.id);
                  const visible = !lockedOff && (locked || !hidden.includes(app.id));
                  return (
                    <li key={app.id} className="flex items-center justify-between py-1 text-sm">
                      <span>
                        {app.name}
                        {locked ? (
                          <span className="ml-2 text-xs text-[var(--color-muted)]">Always shown</span>
                        ) : null}
                        {lockedOff ? (
                          <span
                            data-locked-off="true"
                            className="ml-2 text-xs text-[var(--color-muted)]"
                            title="Only owners and admins can make changes there"
                          >
                            Admins only
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Show ${app.name} to ${ROLE_LABEL[role]}`}
                        checked={visible}
                        disabled={locked || lockedOff || readOnly || saving}
                        onChange={() => toggle(app.id)}
                        className="h-4 w-4"
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {readOnly ? null : (
            <div
              data-component="MenuSaveBar"
              className="sticky bottom-2 flex items-center justify-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
            >
              <span role="status" className="mr-auto text-xs text-[var(--color-muted)]">
                {saving
                  ? "Saving…"
                  : dirty
                    ? `Unsaved changes for ${ROLE_LABEL[role]}`
                    : savedRole === role
                      ? `Saved. ${ROLE_LABEL[role]}s see the new menu within 30 seconds.`
                      : null}
              </span>
              <button
                type="button"
                onClick={discard}
                disabled={!dirty || saving}
                className="rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-40"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="rounded-xl bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
              >
                Save
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

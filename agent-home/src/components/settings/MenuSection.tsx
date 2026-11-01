"use client";

/**
 * Settings → Menu (owner/admin): which launcher items each role sees. One tab
 * per role (admin, member, viewer), a switch per app, grouped like the Coral
 * launcher. Home and Settings are locked on; the owner always sees everything.
 * Hidden items are also refused by URL (see `lib/nav/menu-access.ts`).
 */
import { useEffect, useState } from "react";

import "@/components/coral/coral-apps";
import { getApps } from "@/components/coral/coral-registry";
import { CLUSTER_CATEGORIES, type AppManifest } from "@/components/coral/coral-types";
import { useAction } from "@/lib/use-action";
import { LOCKED_APP_IDS, NAV_ROLES, type NavRole } from "@/lib/nav/menu-access";
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

export function MenuSection() {
  const [nav, setNav] = useState<AgentHomeNav | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<NavRole>("member");

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

  const hidden = nav?.roles?.[role] ?? [];
  const readOnly = !nav?.roles;

  const { run: toggle, pending: saving } = useAction(async (appId: string) => {
    if (!nav?.roles) return;
    const next = hidden.includes(appId) ? hidden.filter((id) => id !== appId) : [...hidden, appId];
    setError(null);
    try {
      const res = await fetch(`/api/settings/menu/${role}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the menu.");
      setNav(body as AgentHomeNav);
    } catch (err) {
      setError((err as Error).message);
    }
  });

  return (
    <section data-section="menu" data-component="MenuSection" className="mt-6">
      <h2 className="text-sm font-semibold">Menu</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Choose which menu items each role sees. Hidden items are also blocked by link. The owner
        always sees everything; Home and Settings are always shown.
      </p>
      <div role="tablist" aria-label="Role" className="mb-3 flex gap-2">
        {NAV_ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={role === r}
            onClick={() => setRole(r)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              role === r
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "border-[var(--color-border)]"
            }`}
          >
            {ROLE_LABEL[r]}
          </button>
        ))}
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
                  const visible = locked || !hidden.includes(app.id);
                  return (
                    <li key={app.id} className="flex items-center justify-between py-1 text-sm">
                      <span>
                        {app.name}
                        {locked ? (
                          <span className="ml-2 text-xs text-[var(--color-muted)]">Always shown</span>
                        ) : null}
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Show ${app.name} to ${ROLE_LABEL[role]}`}
                        checked={visible}
                        disabled={locked || readOnly || saving}
                        onChange={() => toggle(app.id)}
                        className="h-4 w-4"
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

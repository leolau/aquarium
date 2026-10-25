"use client";

import { useCallback, useEffect, useState } from "react";

import { useProjectAction } from "@/components/projects/useProjectAction";
import { ActionButton } from "@/components/ui/ActionButton";
import { Spinner } from "@/components/ui/Spinner";

import { type AppsSettingsKey, useAppsSettingsT } from "./appsSettingsStrings";

/**
 * Settings -> Apps (FG-33 P8-2 2.10): App limits (decision 8), App storage
 * (decision 21) and GitHub token (decision 14). Owner/admin only; Python is
 * the authority (it refuses an admin editing the admins' tier). The token is
 * write-only: the server only ever says whether it is set and its last 4.
 */

type Tier = "member" | "admin";
type Section = "per_app" | "per_member";
type TierLimits = Record<Section, Record<string, number>>;

export type LimitsView = {
  tiers: Record<Tier, TierLimits>;
  defaults: Record<Tier, TierLimits>;
  editable: Record<Tier, boolean>;
  policy?: { source: string; warnings: string[] };
};

export type StorageView = {
  base_path: string;
  default_base_path?: string;
  min_free_mb: number;
  free_mb: number | null;
};

export type GithubView = {
  owner: string | null;
  use_box_git: boolean;
  mode: "token" | "box-git" | "local-only" | string;
  token: { set: boolean; last4: string | null };
};

const SECTIONS: Section[] = ["per_app", "per_member"];
const TIERS: Tier[] = ["member", "admin"];
const BASE = "/api/settings/apps";

type Loaded<T> = { data: T | null; error: string | null; version: number };

function useLoad<T>(path: string): [Loaded<T>, (data: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, version: 0 });
  useEffect(() => {
    let live = true;
    fetch(path, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) setState((s) => ({ data: body as T, error: null, version: s.version + 1 }));
        else setState((s) => ({ ...s, data: null, error: body.detail ?? body.error ?? `HTTP ${res.status}` }));
      })
      .catch(() => live && setState((s) => ({ ...s, data: null, error: "unreachable" })));
    return () => {
      live = false;
    };
  }, [path]);
  const set = useCallback((data: T) => setState((s) => ({ data, error: null, version: s.version + 1 })), []);
  return [state, set];
}

function Card({ title, intro, children, name }: { title: string; intro: string; children: React.ReactNode; name: string }) {
  return (
    <div data-component={`Apps${name}`} className="mt-3 rounded-lg border border-[var(--color-border)] p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{intro}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Status({ loaded, t }: { loaded: { error: string | null }; t: ReturnType<typeof useAppsSettingsT> }) {
  if (loaded.error) return <p className="text-xs text-[var(--color-danger)]">{t("unavailable", { detail: loaded.error })}</p>;
  return (
    <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
      <Spinner /> {t("loading")}
    </p>
  );
}

function Feedback({ error, saved, t }: { error: string | null; saved: boolean; t: ReturnType<typeof useAppsSettingsT> }) {
  if (error) return <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>;
  if (saved) return <p role="status" className="mt-2 text-xs text-[var(--color-muted)]">{t("saved")}</p>;
  return null;
}

const inputClass =
  "w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1 text-sm disabled:opacity-50";
const buttonClass =
  "rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50";

type FormProps<T> = { view: T; saved: boolean; onSaved: (data: T) => void; onEdit: () => void };

/** Loads `path`, then renders `Form` keyed by each fresh server answer so the
 * draft state starts from it (no setState-in-effect). */
function Panel<T>({ path, name, title, intro, Form }: {
  path: string; name: string; title: AppsSettingsKey; intro: AppsSettingsKey;
  Form: (props: FormProps<T>) => React.ReactNode;
}) {
  const t = useAppsSettingsT();
  const [loaded, setLoaded] = useLoad<T>(path);
  const [saved, setSaved] = useState(false);
  return (
    <Card name={name} title={t(title)} intro={t(intro)}>
      {loaded.data ? (
        <Form key={loaded.version} view={loaded.data} saved={saved}
          onSaved={(data) => { setLoaded(data); setSaved(true); }} onEdit={() => setSaved(false)} />
      ) : (
        <Status loaded={loaded} t={t} />
      )}
    </Card>
  );
}

export function LimitsPanel() {
  return <Panel<LimitsView> path={`${BASE}/limits`} name="Limits" title="limitsTitle" intro="limitsIntro" Form={LimitsForm} />;
}

function LimitsForm({ view, saved, onSaved, onEdit }: FormProps<LimitsView>) {
  const t = useAppsSettingsT();
  const action = useProjectAction<LimitsView>();
  const [draft, setDraft] = useState<Record<Tier, TierLimits>>(() => structuredClone(view.tiers));
  const save = (tier: Tier, reset = false) =>
    action.run(`${BASE}/limits`, {
      method: "PUT",
      body: { limits: { [tier]: reset ? null : draft[tier] } },
      skipRefresh: true,
      onSuccess: onSaved,
    });
  return (
    <>
      {TIERS.map((tier) => {
        const editable = view.editable[tier];
        return (
          <fieldset key={tier} data-tier={tier} className="mt-2" disabled={!editable || action.busy}>
            <legend className="text-xs font-semibold">{t(tier === "member" ? "tierMember" : "tierAdmin")}</legend>
            {!editable ? <p className="text-xs text-[var(--color-muted)]">{t("adminTierOwnerOnly")}</p> : null}
            {SECTIONS.map((section) => (
              <div key={section} className="mt-2">
                <p className="text-xs text-[var(--color-muted)]">{t(section === "per_app" ? "perApp" : "perMember")}</p>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {Object.keys(view.defaults[tier][section]).map((key) => {
                    const id = `apps-limit-${tier}-${section}-${key}`;
                    return (
                      <label key={key} htmlFor={id} className="text-xs">
                        {t(`${section}.${key}` as AppsSettingsKey)}
                        <input
                          id={id}
                          type="number"
                          min={0}
                          className={inputClass}
                          value={draft[tier][section][key] ?? ""}
                          onChange={(e) => {
                            onEdit();
                            const next = structuredClone(draft);
                            next[tier][section][key] = Math.max(0, Math.floor(Number(e.target.value) || 0));
                            setDraft(next);
                          }}
                        />
                        <span className="text-[10px] text-[var(--color-muted)]">
                          {t("defaultIs", { value: view.defaults[tier][section][key] })}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            {editable ? (
              <div className="mt-2 flex gap-2">
                <ActionButton className={buttonClass} data-action={`save-limits-${tier}`} busy={action.busy} busyLabel={t("saving")} onAction={() => save(tier)}>
                  {t("save")}
                </ActionButton>
                <ActionButton className="rounded border px-3 py-1.5 text-sm" data-action={`reset-limits-${tier}`} busy={action.busy} onAction={() => save(tier, true)}>
                  {t("reset")}
                </ActionButton>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <Feedback error={action.error} saved={saved} t={t} />
    </>
  );
}

export function StoragePanel() {
  return <Panel<StorageView> path={`${BASE}/storage`} name="Storage" title="storageTitle" intro="storageIntro" Form={StorageForm} />;
}

function StorageForm({ view, saved, onSaved, onEdit }: FormProps<StorageView>) {
  const t = useAppsSettingsT();
  const action = useProjectAction<StorageView>();
  const [path, setPath] = useState(view.base_path);
  const [minFree, setMinFree] = useState(view.min_free_mb);
  const change: { base_path?: string; min_free_mb?: number } = {};
  if (path.trim() !== view.base_path) change.base_path = path.trim();
  if (minFree !== view.min_free_mb) change.min_free_mb = minFree;
  return (
    <>
      <label htmlFor="apps-storage-path" className="text-xs">
        {t("storagePath")}
        <input id="apps-storage-path" className={inputClass} value={path} disabled={action.busy}
          onChange={(e) => { onEdit(); setPath(e.target.value); }} />
      </label>
      <label htmlFor="apps-storage-min-free" className="mt-2 block text-xs">
        {t("storageMinFree")}
        <input id="apps-storage-min-free" type="number" min={0} className={inputClass} value={minFree} disabled={action.busy}
          onChange={(e) => { onEdit(); setMinFree(Math.max(0, Math.floor(Number(e.target.value) || 0))); }} />
      </label>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        {view.free_mb === null ? t("storageFreeUnknown") : t("storageFree", { free: view.free_mb })} {t("storageMoveNote")}
      </p>
      <ActionButton
        className={`mt-2 ${buttonClass}`}
        data-action="save-storage"
        disabled={!Object.keys(change).length}
        busy={action.busy}
        busyLabel={t("saving")}
        onAction={() =>
          action.run(`${BASE}/storage`, {
            method: "PUT",
            body: change,
            skipRefresh: true,
            onSuccess: onSaved,
          })
        }
      >
        {t("save")}
      </ActionButton>
      <Feedback error={action.error} saved={saved} t={t} />
    </>
  );
}

export function GithubPanel() {
  return <Panel<GithubView> path={`${BASE}/github`} name="Github" title="githubTitle" intro="githubIntro" Form={GithubForm} />;
}

function GithubForm({ view, saved, onSaved, onEdit }: FormProps<GithubView>) {
  const t = useAppsSettingsT();
  const action = useProjectAction<GithubView>();
  const [owner, setOwner] = useState(view.owner ?? "");
  const [token, setToken] = useState("");
  const [boxGit, setBoxGit] = useState(view.use_box_git);
  const done = onSaved;
  const change: { owner?: string; use_box_git?: boolean; token?: string } = {};
  if (owner.trim() !== (view.owner ?? "")) change.owner = owner.trim();
  if (boxGit !== view.use_box_git) change.use_box_git = boxGit;
  if (token.trim()) change.token = token.trim();
  const modeKey = `mode.${view.mode}` as AppsSettingsKey;
  return (
    <>
      <p data-github-mode={view.mode} className="text-xs">{t(modeKey) ?? view.mode}</p>
      <label htmlFor="apps-github-owner" className="mt-2 block text-xs">
        {t("githubOwner")}
        <input id="apps-github-owner" className={inputClass} value={owner} disabled={action.busy} autoComplete="off"
          onChange={(e) => { onEdit(); setOwner(e.target.value); }} />
      </label>
      <label htmlFor="apps-github-token" className="mt-2 block text-xs">
        {t("githubToken")}:{" "}
        <span data-token-status={view.token.set ? "set" : "unset"}>
          {view.token.set ? t("githubTokenSet", { last4: view.token.last4 ?? "" }) : t("githubTokenUnset")}
        </span>
        <input id="apps-github-token" type="password" autoComplete="new-password" className={inputClass}
          placeholder={t("githubTokenPlaceholder")} value={token} disabled={action.busy}
          onChange={(e) => { onEdit(); setToken(e.target.value); }} />
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={boxGit} disabled={action.busy}
          onChange={(e) => { onEdit(); setBoxGit(e.target.checked); }} />
        {t("githubBoxGit")}
      </label>
      <div className="mt-2 flex gap-2" data-appmcp-deny="consent">
        <ActionButton
          className={buttonClass}
          data-action="save-github"
          disabled={!Object.keys(change).length}
          busy={action.busy}
          busyLabel={t("saving")}
          onAction={() =>
            action.run(`${BASE}/github`, { method: "PUT", body: change, skipRefresh: true, onSuccess: done })
          }
        >
          {t("save")}
        </ActionButton>
        {view.token.set ? (
          <ActionButton
            className="rounded border px-3 py-1.5 text-sm"
            data-action="remove-github-token"
            data-appmcp-deny="consent"
            busy={action.busy}
            busyLabel={t("githubRemoving")}
            onAction={() => action.run(`${BASE}/github`, { method: "DELETE", skipRefresh: true, onSuccess: done })}
          >
            {t("githubRemove")}
          </ActionButton>
        ) : null}
      </div>
      <Feedback error={action.error} saved={saved} t={t} />
    </>
  );
}

export function AppsSettings() {
  const t = useAppsSettingsT();
  return (
    <section data-section="apps" data-component="AppsSettings" className="mt-6">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{t("intro")}</p>
      <LimitsPanel />
      <StoragePanel />
      <GithubPanel />
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { inputClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { DirectoryEntry } from "@/types";
import type { SiteInput, SiteRefreshMode, SiteSource } from "@/types/sites";

import { JSON_HEADERS, presetToCron, readJson, sitePath, type SchedulePreset } from "./format";
import { SchedulePicker } from "./SchedulePicker";

export interface AddSiteDraft {
  name: string;
  base_url: string;
  login_url: string;
  username: string;
  password: string;
  schedule: SchedulePreset;
  mode: SiteRefreshMode;
}

/** The `POST /api/sites` body for a draft: blanks are left out, never sent empty. */
export function toSiteInput(d: AddSiteDraft, offsetMinutes: number): SiteInput {
  const body: SiteInput = { base_url: d.base_url.trim(), default_refresh_mode: d.mode };
  if (d.name.trim()) body.name = d.name.trim();
  if (d.login_url.trim()) body.login_url = d.login_url.trim();
  if (d.username.trim() && d.password) {
    body.username = d.username.trim();
    body.password = d.password;
  }
  const cron = presetToCron(d.schedule, offsetMinutes);
  if (cron) body.schedule_cron = cron;
  return body;
}

const EMPTY: AddSiteDraft = {
  name: "",
  base_url: "",
  login_url: "",
  username: "",
  password: "",
  schedule: { kind: "off" },
  mode: "incremental",
};

/**
 * Add a site: where it is, how to sign in, who else sees it. Creating it only
 * registers the source; the agent studies it and proposes a design next.
 */
export function AddSiteForm({ people, me }: { people: DirectoryEntry[]; me: string }) {
  const t = useT("sites");
  const router = useRouter();
  const [draft, setDraft] = useState<AddSiteDraft>(EMPTY);
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const others = people.filter((p) => p.user_id !== me);
  const set = <K extends keyof AddSiteDraft>(k: K, v: AddSiteDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const loginHalf = Boolean(draft.username.trim()) !== Boolean(draft.password);

  const submit = useAction(async () => {
    setError(null);
    try {
      const body = toSiteInput(draft, new Date().getTimezoneOffset());
      const { site } = await readJson<{ site: SiteSource }>(
        await fetch("/api/sites", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
      );
      if (visibility === "shared") {
        for (const user_id of shareWith) {
          await readJson(
            await fetch(sitePath(site.id, "grants"), {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify({ user_id, grant: "read" }),
            }),
          );
        }
      }
      router.push(`/sites/${site.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit.run();
  }

  return (
    <form data-component="AddSiteForm" onSubmit={onSubmit} className="space-y-4">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <fieldset className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <legend className="px-1 text-sm font-semibold">{t("add.whereLegend")}</legend>
        <label className="block space-y-1 text-sm">
          <span>{t("add.baseUrl")}</span>
          <input
            required
            type="url"
            placeholder="https://wms.example.com"
            className={inputClass}
            value={draft.base_url}
            onChange={(e) => set("base_url", e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("add.name")}</span>
          <input className={inputClass} value={draft.name} onChange={(e) => set("name", e.target.value)} />
          <span className="text-xs text-[var(--color-muted)]">{t("add.nameHint")}</span>
        </label>
      </fieldset>
      <fieldset className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <legend className="px-1 text-sm font-semibold">{t("add.loginLegend")}</legend>
        <p className="text-xs text-[var(--color-muted)]">{t("add.loginHint")}</p>
        <label className="block space-y-1 text-sm">
          <span>{t("add.loginUrl")}</span>
          <input
            type="url"
            placeholder="https://wms.example.com/login"
            className={inputClass}
            value={draft.login_url}
            onChange={(e) => set("login_url", e.target.value)}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span>{t("add.username")}</span>
            <input
              autoComplete="off"
              className={inputClass}
              value={draft.username}
              onChange={(e) => set("username", e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t("add.password")}</span>
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={draft.password}
              onChange={(e) => set("password", e.target.value)}
            />
          </label>
        </div>
        {loginHalf ? <p className="text-xs text-[var(--color-warn-text)]">{t("add.loginBoth")}</p> : null}
      </fieldset>
      <fieldset className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <legend className="px-1 text-sm font-semibold">{t("add.visibilityLegend")}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="visibility"
            checked={visibility === "private"}
            onChange={() => setVisibility("private")}
          />
          <span>{t("add.visibilityPrivate")}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="visibility"
            checked={visibility === "shared"}
            disabled={others.length === 0}
            onChange={() => setVisibility("shared")}
          />
          <span>{t("add.visibilityShared")}</span>
        </label>
        {visibility === "shared" ? (
          <ul className="space-y-1 pl-6">
            {others.map((p) => (
              <li key={p.user_id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={shareWith.includes(p.user_id)}
                    onChange={(e) =>
                      setShareWith((s) => (e.target.checked ? [...s, p.user_id] : s.filter((x) => x !== p.user_id)))
                    }
                  />
                  {p.display || p.user_id}
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
      <fieldset className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <legend className="px-1 text-sm font-semibold">{t("add.scheduleLegend")}</legend>
        <SchedulePicker value={draft.schedule} onChange={(v) => set("schedule", v)} />
        <label className="flex items-center gap-2 text-sm">
          {t("schedule.defaultMode")}
          <select
            className={`${inputClass} w-auto`}
            value={draft.mode}
            onChange={(e) => set("mode", e.target.value as SiteRefreshMode)}
          >
            <option value="incremental">{t("mode.incremental")}</option>
            <option value="full">{t("mode.full")}</option>
          </select>
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          type="submit"
          busy={submit.pending}
          busyLabel={t("add.creating")}
          disabled={!draft.base_url.trim() || loginHalf}
          className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {t("add.create")}
        </ActionButton>
        <button type="button" className={secondaryButtonClass} onClick={() => router.push("/sites")}>
          {t("common.cancel")}
        </button>
      </div>
      <p className="text-xs text-[var(--color-muted)]">{t("add.next")}</p>
    </form>
  );
}

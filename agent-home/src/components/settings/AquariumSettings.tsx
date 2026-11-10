"use client";

import { useEffect, useState } from "react";

import { CreatureIcon } from "@/components/aquarium/CreatureIcon";
import { ActionButton } from "@/components/ui/ActionButton";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import {
  AQUARIUM_NAME_DEFAULT,
  AQUARIUM_NAME_MAX,
  CREATURES,
  IDLE_SECONDS_DEFAULT,
  IDLE_SECONDS_MAX,
  IDLE_SECONDS_MIN,
  isCreatureId,
  type CreatureId,
} from "@/lib/aquarium/creatures";
import { isValidIdleSeconds } from "@/lib/aquarium/useIdleRedirect";
import { useAction } from "@/lib/use-action";

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** `"30"` → 30; anything that is not a whole number in range → null. */
export function parseIdleInput(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return isValidIdleSeconds(n) ? n : null;
}

/** A typed name → what to save: trimmed, at most `AQUARIUM_NAME_MAX` characters; `""` means the default. */
export function normaliseNameInput(raw: string): string | null {
  const s = raw.trim();
  return Array.from(s).length <= AQUARIUM_NAME_MAX ? s : null;
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** `PUT /api/aquarium/settings` with a subset; returns the full settings. */
async function putSettings(body: { idle_seconds?: number; name?: string }): Promise<{ idle_seconds?: unknown; name?: unknown }> {
  const res = await fetch("/api/aquarium/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await detailOf(res));
  return (await res.json()) as { idle_seconds?: unknown; name?: unknown };
}

/**
 * Settings → Aquarium dashboard: the aquarium's name and how long the home
 * page waits with no activity before it switches to the dashboard.
 * Box-wide; owner/admin only.
 */
export function AquariumIdleSetting({ canEdit }: { canEdit: boolean }) {
  const t = useT("settings");
  const [value, setValue] = useState(String(IDLE_SECONDS_DEFAULT));
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    if (!canEdit) return;
    const ac = new AbortController();
    void (async () => {
      let body: { idle_seconds?: unknown; name?: unknown } = {};
      try {
        const res = await fetch("/api/aquarium/settings", { cache: "no-store", signal: ac.signal });
        if (res.ok) body = (await res.json()) as typeof body;
      } catch {
        // Keep the defaults.
      }
      if (ac.signal.aborted) return;
      setValue(String(isValidIdleSeconds(body?.idle_seconds) ? body.idle_seconds : IDLE_SECONDS_DEFAULT));
      setName(isName(body?.name) && body.name !== AQUARIUM_NAME_DEFAULT ? body.name : "");
      setLoaded(true);
    })();
    return () => ac.abort();
  }, [canEdit]);

  const parsedName = normaliseNameInput(name);
  const saveName = useAction(async () => {
    if (parsedName === null) return;
    setNameError(null);
    setNameSaved(false);
    try {
      const body = await putSettings({ name: parsedName });
      if (isName(body.name)) setName(body.name === AQUARIUM_NAME_DEFAULT ? "" : body.name);
      setNameSaved(true);
    } catch (err) {
      setNameError(t("aquarium.name.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    }
  });

  const parsed = parseIdleInput(value);
  const save = useAction(async () => {
    if (parsed === null) return;
    setError(null);
    setSaved(false);
    try {
      const body = await putSettings({ idle_seconds: parsed });
      if (isValidIdleSeconds(body.idle_seconds)) setValue(String(body.idle_seconds));
      setSaved(true);
    } catch (err) {
      setError(t("aquarium.idle.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    }
  });

  if (!canEdit) return null;
  const range = { min: IDLE_SECONDS_MIN, max: IDLE_SECONDS_MAX };
  return (
    <section
      data-section="aquarium"
      data-component="AquariumIdleSetting"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-base font-semibold">{t("aquarium.name.title")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("aquarium.name.hint", { max: AQUARIUM_NAME_MAX })}</p>
      <form
        data-form="aquarium-name"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void saveName.run();
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm sm:max-w-sm">
          <span>{t("aquarium.name.label")}</span>
          <input
            type="text"
            name="aquarium-name"
            autoComplete="off"
            maxLength={AQUARIUM_NAME_MAX}
            placeholder={AQUARIUM_NAME_DEFAULT}
            value={name}
            aria-invalid={parsedName === null}
            aria-busy={!loaded}
            onChange={(e) => {
              setName(e.target.value);
              setNameSaved(false);
            }}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
        </label>
        <ActionButton
          type="submit"
          busy={saveName.pending}
          busyLabel={t("aquarium.idle.saving")}
          disabled={parsedName === null}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {t("aquarium.idle.save")}
        </ActionButton>
      </form>
      {parsedName === null ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {t("aquarium.name.invalid", { max: AQUARIUM_NAME_MAX })}
        </p>
      ) : null}
      {nameError ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {nameError}
        </p>
      ) : null}
      {nameSaved ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-success)]">
          {t("aquarium.idle.saved")}
        </p>
      ) : null}

      <h2 className="mt-5 border-t border-[var(--color-border)] pt-4 text-base font-semibold">{t("aquarium.idle.title")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("aquarium.idle.hint", range)}</p>
      <form
        data-form="aquarium-idle"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("aquarium.idle.label")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={IDLE_SECONDS_MIN}
            max={IDLE_SECONDS_MAX}
            step={1}
            value={value}
            aria-invalid={parsed === null}
            aria-busy={!loaded}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
        </label>
        <ActionButton
          type="submit"
          busy={save.pending}
          busyLabel={t("aquarium.idle.saving")}
          disabled={parsed === null}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {t("aquarium.idle.save")}
        </ActionButton>
      </form>
      {parsed === null ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {t("aquarium.idle.invalid", range)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-success)]">
          {t("aquarium.idle.saved")}
        </p>
      ) : null}
    </section>
  );
}

/** The signed-in person's own creature in the Aquarium dashboard. */
export function CreaturePicker() {
  const t = useT("settings");
  const [current, setCurrent] = useState<CreatureId | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<CreatureId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/me/creature", { cache: "no-store", signal: ac.signal });
        if (!res.ok) throw new Error(await detailOf(res));
        const body = (await res.json()) as { creature?: unknown };
        if (!ac.signal.aborted && isCreatureId(body.creature)) setCurrent(body.creature);
      } catch {
        if (!ac.signal.aborted) setFailed(true);
      }
    })();
    return () => ac.abort();
  }, []);

  async function choose(id: CreatureId) {
    if (saving || id === current) return;
    setSaving(id);
    setError(null);
    try {
      const res = await fetch("/api/me/creature", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creature: id }),
      });
      if (!res.ok) throw new Error(await detailOf(res));
      const body = (await res.json()) as { creature?: unknown };
      setCurrent(isCreatureId(body.creature) ? body.creature : id);
      setFailed(false);
    } catch (err) {
      setError(t("creature.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    } finally {
      setSaving(null);
    }
  }

  const name = (id: CreatureId, fallback: string) =>
    t.has(`creature.name.${id}`) ? t(`creature.name.${id}`) : fallback;

  return (
    <section
      data-component="CreaturePicker"
      aria-busy={saving !== null}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <h2 className="text-base font-semibold">{t("creature.title")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("creature.hint")}</p>
      {failed ? <p className="mb-2 text-xs text-[var(--color-muted)]">{t("creature.loadFailed")}</p> : null}
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <ul data-component="CreatureGrid" className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
        {CREATURES.map((c) => {
          const active = c.id === current;
          return (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={active}
                data-creature-option={c.id}
                disabled={saving !== null}
                onClick={() => void choose(c.id)}
                className={`group flex h-full w-full flex-col items-center gap-1 rounded-xl border p-2 text-center text-xs transition-colors disabled:opacity-60 ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)] ring-2 ring-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
                }`}
              >
                <span className="flex h-14 w-14 items-center justify-center">
                  {saving === c.id ? (
                    <Spinner />
                  ) : (
                    <CreatureIcon
                      id={c.id}
                      size={56}
                      className="transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                    />
                  )}
                </span>
                <span className="leading-tight">{name(c.id, c.label)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

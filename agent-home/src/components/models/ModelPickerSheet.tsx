"use client";

import { useEffect, useMemo, useState } from "react";

import type { ModelSlot } from "@/components/models/ModelsView";
import { Spinner } from "@/components/ui/Spinner";
import { withProfileBody, withProfileQuery } from "@/lib/chat/profile";
import type {
  AuxTaskAssignment,
  FallbackModel,
  ModelOptionsResponse,
  ModelSetResponse,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "confirm-expensive"; message: string }
  | { kind: "confirm-disconnect" };

/** Pseudo-value for the provider dropdown's "custom endpoint" entry. */
const CUSTOM_PROVIDER = "__custom";

/**
 * The model picker bottom sheet, opened by tapping the main-model card or a
 * task-role row. Covers three provider states:
 *   authenticated            → model list + Set (+ Disconnect at the bottom)
 *   unauthenticated, api_key → inline "Add API key" (validate → save → list)
 *   unauthenticated, other   → pointer to onboarding (OAuth stays elsewhere)
 *
 * All writes go through `/api/models/*` BFF routes; `confirm_required`
 * responses become an inline confirm that re-sends with
 * `confirm_expensive_model: true`.
 */
export function ModelPickerSheet({
  slot,
  currentMain,
  currentAssignment,
  fallbacks = [],
  lastResort = null,
  profile,
  onClose,
  onChanged,
  onRefresh,
  onError,
}: {
  slot: ModelSlot;
  currentMain: { provider: string; model: string };
  currentAssignment?: AuxTaskAssignment;
  /** The current backup list — a fallback slot edits one entry of it. */
  fallbacks?: FallbackModel[];
  /** Built-in last step for "auto" roles (first provider with a key). */
  lastResort?: FallbackModel | null;
  profile?: string;
  onClose: () => void;
  onChanged: () => void;
  /** Reload the page's data without closing the sheet (backup edits). */
  onRefresh?: () => unknown;
  onError: (message: string | null) => void;
}) {
  const roleTask = slot.kind === "aux" ? slot.task : undefined;
  const [backups, setBackups] = useState<FallbackModel[]>(
    slot.kind === "main"
      ? fallbacks
      : slot.kind === "aux"
        ? currentAssignment?.fallback_chain ?? []
        : [],
  );
  const [backupNote, setBackupNote] = useState<string | null>(null);

  async function saveBackups(next: FallbackModel[]) {
    setBackupNote(null);
    try {
      const res = await fetch("/api/models/fallback", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withProfileBody({ providers: next, task: roleTask }, profile)),
      });
      const body = (await res.json().catch(() => ({}))) as {
        providers?: FallbackModel[];
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the backups.");
      setBackups(body.providers ?? next);
      await onRefresh?.();
    } catch (err) {
      setBackupNote(err instanceof Error ? err.message : "Couldn't save the backups.");
    }
  }

  const editedFallback =
    slot.kind === "fallback" && slot.index != null ? fallbacks[slot.index] : undefined;
  const title =
    slot.kind === "main"
      ? "Main model"
      : slot.kind === "fallback"
        ? slot.index == null
          ? "Add a backup model"
          : `Backup model ${slot.index + 1}`
        : `${slot.label} model`;
  const subtitle =
    slot.kind === "main"
      ? "the brain every session starts with"
      : slot.kind === "fallback"
        ? "tried in order when the main model fails"
        : `${slot.hint} · currently ${describeAssignment(currentAssignment, currentMain)}`;

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [options, setOptions] = useState<ModelOptionsResponse | null>(null);
  const [providerSlug, setProviderSlug] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [typedModel, setTypedModel] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [busy, setBusy] = useState<"set" | "key" | "reset" | "disconnect" | null>(null);
  const [testing, setTesting] = useState(false);
  const [showChangeKey, setShowChangeKey] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOptions = async () => {
    try {
      const res = await fetch(withProfileQuery("/api/models/options", profile), {
        cache: "no-store",
      });
      const body = (await res.json()) as ModelOptionsResponse & { detail?: string };
      if (!res.ok) throw new Error(body.detail ?? "Failed to load model options.");
      setOptions(body);
      setLoadError(null);
      return body;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load model options.");
      return null;
    }
  };

  const loadInitial = async () => {
    const body = await loadOptions();
    if (!body) return;
    // Seed the provider dropdown from the slot's current assignment.
    const initial =
      slot.kind === "main"
        ? currentMain.provider || body.provider || body.providers[0]?.slug || ""
        : slot.kind === "fallback"
          ? editedFallback?.provider || body.provider || body.providers[0]?.slug || ""
          : currentAssignment && currentAssignment.provider !== "auto"
            ? currentAssignment.provider
            : body.provider || body.providers[0]?.slug || "";
    setProviderSlug(initial);
    setSelectedModel(
      slot.kind === "main"
        ? currentMain.model
        : slot.kind === "fallback"
          ? editedFallback?.model ?? ""
          : currentAssignment?.model ?? "",
    );
    setPhase({ kind: "ready" });
  };

  useEffect(() => {
    const t = setTimeout(() => void loadInitial(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = useMemo(
    () => options?.providers.find((p) => p.slug === providerSlug) ?? null,
    [options, providerSlug],
  );
  const isCustomEndpoint = providerSlug === CUSTOM_PROVIDER;
  const authenticated = provider?.authenticated === true;
  const keyBased = provider?.auth_type === "api_key" && !!provider?.key_env;
  const needsEndpoint = !!provider?.base_url_env;

  async function saveFallback(model: string) {
    if (!provider || slot.kind !== "fallback") return;
    const entry = { provider: provider.slug, model };
    const next =
      slot.index == null
        ? [...fallbacks, entry]
        : fallbacks.map((f, i) => (i === slot.index ? entry : f));
    const res = await fetch("/api/models/fallback", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withProfileBody({ providers: next }, profile)),
    });
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    if (!res.ok) throw new Error(body.detail ?? "Couldn't save the backup model.");
    onChanged();
  }

  async function setModel(confirmExpensive: boolean) {
    const model = typedModel.trim() || selectedModel;
    if (!provider || !model || busy) return;
    setBusy("set");
    setNote(null);
    try {
      if (slot.kind === "fallback") {
        await saveFallback(model);
        return;
      }
      const res = await fetch("/api/models/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          withProfileBody(
            {
              scope: slot.kind === "main" ? "main" : "auxiliary",
              task: slot.kind === "aux" ? slot.task : undefined,
              provider: provider.slug,
              model,
              confirm_expensive_model: confirmExpensive,
            },
            profile,
          ),
        ),
      });
      const body = (await res.json()) as ModelSetResponse;
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the model.");
      if (body.confirm_required) {
        setPhase({ kind: "confirm-expensive", message: body.confirm_message ?? "" });
        return;
      }
      if (body.stale_aux?.length) {
        onError(
          `Saved — but ${body.stale_aux.length} role(s) are still pinned to ` +
            `${body.stale_aux[0].provider}; they won't follow the new main model.`,
        );
      }
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't save the model.");
    } finally {
      setBusy(null);
    }
  }

  async function resetToAuto() {
    if (slot.kind !== "aux" || busy) return;
    setBusy("reset");
    setNote(null);
    try {
      const res = await fetch("/api/models/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          withProfileBody(
            { scope: "auxiliary", task: slot.task, provider: "auto", model: "" },
            profile,
          ),
        ),
      });
      const body = (await res.json()) as ModelSetResponse;
      if (!res.ok) throw new Error(body.detail ?? "Couldn't reset the role.");
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't reset the role.");
    } finally {
      setBusy(null);
    }
  }

  /** Point the main slot at an OpenAI-compatible endpoint not in the catalog. */
  async function setCustomEndpoint(confirmExpensive: boolean) {
    const url = endpointUrl.trim();
    const model = customModel.trim();
    if (!url || !model || busy) return;
    setBusy("set");
    setNote(null);
    try {
      const res = await fetch("/api/models/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          withProfileBody(
            {
              scope: "main",
              provider: "custom",
              model,
              base_url: url,
              api_key: customKey.trim() || undefined,
              confirm_expensive_model: confirmExpensive,
            },
            profile,
          ),
        ),
      });
      const body = (await res.json()) as ModelSetResponse;
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the endpoint.");
      if (body.confirm_required) {
        setPhase({ kind: "confirm-expensive", message: body.confirm_message ?? "" });
        return;
      }
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't save the endpoint.");
    } finally {
      setBusy(null);
    }
  }

  async function saveKey() {
    if (!provider?.key_env || busy) return;
    // Only first-time connect must supply the endpoint URL — when changing
    // the key on an already-connected provider the env var is on disk.
    if (!authenticated && needsEndpoint && !endpointUrl.trim()) {
      setNote(`${provider.name} needs its endpoint URL too.`);
      return;
    }
    setBusy("key");
    setNote(null);
    try {
      const res = await fetch("/api/models/provider-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          withProfileBody(
            {
              key: provider.key_env,
              value: keyValue,
              extra_env:
                needsEndpoint && endpointUrl.trim()
                  ? { [provider.base_url_env as string]: endpointUrl.trim() }
                  : undefined,
            },
            profile,
          ),
        ),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        verified?: boolean;
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail ?? "Couldn't save the key.");
      setKeyValue("");
      setShowChangeKey(false);
      setNote(
        body.verified
          ? "Key saved and verified."
          : "Key saved — couldn't verify it remotely; the catalog below is the real test.",
      );
      // The provider now authenticates: refetch so its model list appears.
      await loadOptions();
      setPhase({ kind: "ready" });
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't save the key.");
    } finally {
      setBusy(null);
    }
  }

  /** Fire one real completion against the selected provider+model —
   *  proves the choice works before (or without) saving it. */
  async function testSelection() {
    const model = typedModel.trim() || selectedModel;
    if (!provider || !model || busy || testing) return;
    setTesting(true);
    setNote(null);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          withProfileBody(
            { scope: "main", provider: provider.slug, model },
            profile,
          ),
        ),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        model?: string;
        latency_ms?: number;
        reply?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setNote(body.detail ?? "Test request failed.");
      } else if (body.ok) {
        const secs = ((body.latency_ms ?? 0) / 1000).toFixed(1);
        setNote(
          `✓ ${body.model ?? model} replied in ${secs}s` +
            (body.reply ? ` — “${body.reply}”` : ""),
        );
      } else {
        setNote(`✗ ${body.error ?? "Test failed."}`);
      }
    } catch {
      setNote("Couldn't reach the test endpoint.");
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    if (!provider?.key_env || busy) return;
    setBusy("disconnect");
    setNote(null);
    try {
      const res = await fetch("/api/models/provider-key", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withProfileBody({ key: provider.key_env }, profile)),
      });
      const body = (await res.json()) as { ok?: boolean; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? "Couldn't disconnect the provider.");
      await loadOptions();
      setPhase({ kind: "ready" });
      setNote(`${provider.name} disconnected — slots pinned to it fall back to auto.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't disconnect the provider.");
      setPhase({ kind: "ready" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-component="ModelPickerSheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-sm flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-[var(--color-border)] sm:hidden" />
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-[var(--color-muted)]">
            Close
          </button>
        </div>

        {loadError ? (
          <p className="mb-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-red-300">
            {loadError}
          </p>
        ) : null}
        {note ? (
          <p className="mb-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)]">
            {note}
          </p>
        ) : null}

        {phase.kind === "loading" ? (
          loadError && !options ? (
            <div className="flex flex-col items-center gap-2 py-8">
              <p className="text-sm text-[var(--color-muted)]">
                Couldn't load providers.
              </p>
              <ActionButton
                onAction={() => loadInitial()}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white"
              >
                Try again
              </ActionButton>
            </div>
          ) : (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-accent)]"
            >
              <Spinner size="md" />
              Loading providers…
            </p>
          )
        ) : phase.kind === "confirm-expensive" ? (
          <div className="space-y-3">
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-warn-text)]">
              {phase.message || "This model may be expensive."}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPhase({ kind: "ready" })}
                className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs"
              >
                Back
              </button>
              <ActionButton
                disabled={busy !== null}
                onAction={() => {
                  setPhase({ kind: "ready" });
                  return (isCustomEndpoint
                    ? setCustomEndpoint(true)
                    : setModel(true));
                }}
                className="ml-auto rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
              >
                Use it anyway
              </ActionButton>
            </div>
          </div>
        ) : phase.kind === "confirm-disconnect" && provider ? (
          <div className="space-y-3">
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Disconnect {provider.name}? Its key is removed from .env — any
              roles pinned to it fall back to the main model.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPhase({ kind: "ready" })}
                className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs"
              >
                Keep it
              </button>
              <ActionButton
                disabled={busy !== null}
                onAction={() => disconnect()}
                className="ml-auto inline-flex items-center gap-2 rounded-full bg-red-500/80 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {busy === "disconnect" ? <Spinner /> : null}
                Disconnect
              </ActionButton>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <label className="mb-1 text-xs text-[var(--color-muted)]">Provider</label>
            <select
              value={providerSlug}
              onChange={(e) => {
                setProviderSlug(e.target.value);
                setSelectedModel("");
                setTypedModel("");
                setNote(null);
              }}
              className="mb-3 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm"
            >
              {(options?.providers ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                  {p.authenticated ? "" : " — not connected"}
                </option>
              ))}
              {slot.kind === "main" ? (
                <option value={CUSTOM_PROVIDER}>
                  Custom endpoint (OpenAI-compatible)…
                </option>
              ) : null}
            </select>

            {isCustomEndpoint ? (
              <div>
                <p className="mb-2 rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
                  Point Hermes at any OpenAI-compatible endpoint — vLLM,
                  Ollama, LiteLLM, a provider not in the catalog.
                </p>
                <input
                  type="url"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="Endpoint URL — https://host/v1"
                  autoComplete="off"
                  className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                />
                <input
                  type="password"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="API key (optional)"
                  autoComplete="off"
                  className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                />
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="Model ID — e.g. meta-llama/Llama-3.3-70B"
                  autoComplete="off"
                  className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                  <ActionButton
                    disabled={!endpointUrl.trim() || !customModel.trim() || busy !== null}
                    onAction={() => setCustomEndpoint(false)}
                    className="ml-auto inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
                  >
                    {busy === "set" ? <Spinner /> : null}
                    Set model
                  </ActionButton>
                </div>
              </div>
            ) : provider && !authenticated && keyBased ? (
              <div>
                <p className="mb-2 rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-fg)]">{provider.name}</span>{" "}
                  isn&apos;t connected yet. Paste its API key — it&apos;s
                  validated, then stored in Hermes&apos; .env.
                </p>
                {needsEndpoint ? (
                  <input
                    type="url"
                    value={endpointUrl}
                    onChange={(e) => setEndpointUrl(e.target.value)}
                    placeholder={`Endpoint URL (${provider.base_url_env})`}
                    autoComplete="off"
                    className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                  />
                ) : null}
                <input
                  type="password"
                  value={keyValue}
                  onChange={(e) => setKeyValue(e.target.value)}
                  placeholder={provider.key_env ?? "API key"}
                  autoComplete="off"
                  className="mb-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                  <ActionButton
                    disabled={!keyValue.trim() || busy !== null}
                    onAction={() => saveKey()}
                    className="ml-auto inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
                  >
                    {busy === "key" ? <Spinner /> : null}
                    Save key
                  </ActionButton>
                </div>
              </div>
            ) : provider && !authenticated && !keyBased ? (
              <p className="rounded-lg bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
                {provider.name} uses {provider.auth_type || "a dedicated"} sign-in —
                connect it from <span className="font-medium">Getting started</span>,
                then pick its model here.
              </p>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                  {(provider?.models ?? []).length === 0 ? (
                    <p className="p-3 text-xs text-[var(--color-muted)]">
                      No models listed for this provider.
                    </p>
                  ) : (
                    (provider?.models ?? []).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setSelectedModel(m);
                          setTypedModel("");
                        }}
                        className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm ${
                          selectedModel === m && !typedModel
                            ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : ""
                        }`}
                      >
                        <span className="min-w-0 truncate">{m}</span>
                        {selectedModel === m && !typedModel ? <span>✓</span> : null}
                      </button>
                    ))
                  )}
                </div>
                <input
                  type="text"
                  value={typedModel}
                  onChange={(e) => setTypedModel(e.target.value)}
                  placeholder="Or type a model ID not listed above…"
                  autoComplete="off"
                  className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
                />
                <div className="mt-3 flex gap-2">
                  {slot.kind === "aux" ? (
                    <ActionButton
                      disabled={busy !== null || testing}
                      onAction={() => resetToAuto()}
                      className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60"
                    >
                      {busy === "reset" ? <Spinner /> : null}
                      Reset to auto
                    </ActionButton>
                  ) : null}
                  <ActionButton busyLabel="Testing…"
                    disabled={(!selectedModel && !typedModel.trim()) || busy !== null || testing}
                    onAction={() => testSelection()}
                    className="ml-auto inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60"
                  >
                    {testing ? <Spinner /> : null}
                    {testing ? "Testing…" : "Test"}
                  </ActionButton>
                  <ActionButton
                    busyLabel="Saving…"
                    disabled={(!selectedModel && !typedModel.trim()) || busy !== null || testing}
                    onAction={() => setModel(false)}
                    className="inline-flex items-center gap-2 rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
                  >
                    {slot.kind === "fallback" ? "Save backup" : "Set model"}
                  </ActionButton>
                </div>
                {slot.kind !== "fallback" ? (
                  <div
                    data-component="RoleBackups"
                    className="mt-3 border-t border-[var(--color-border)] pt-3"
                  >
                    <div className="text-xs font-semibold">Backups for this role</div>
                    <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                      If this role&apos;s model fails: {[
                        ...backups.map((b) => b.model),
                        slot.kind === "main"
                          ? "the request fails"
                          : currentAssignment && currentAssignment.provider !== "auto"
                            ? `the Main model (${currentMain.model || "main"})`
                            : "the Main backup list",
                        ...(slot.kind === "aux" &&
                        (!currentAssignment || currentAssignment.provider === "auto")
                          ? [
                            lastResort
                              ? `then any connected provider (${lastResort.provider}: ${lastResort.model})`
                              : "then any connected provider (none has a key)",
                          ]
                          : []),
                      ].join(" → ")}
                    </p>
                    {backups.map((b, i) => (
                      <div key={`${b.provider}:${b.model}`} className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="w-4 text-[var(--color-muted)]">{i + 1}.</span>
                        <span className="min-w-0 truncate">
                          {b.model} <span className="text-[var(--color-muted)]">· {b.provider}</span>
                        </span>
                        <span className="ml-auto flex shrink-0 gap-1">
                          <ActionButton
                            aria-label={`Move backup ${b.model} up`}
                            busyLabel="…"
                            disabled={i === 0}
                            onAction={() => {
                              const next = [...backups];
                              [next[i - 1], next[i]] = [next[i], next[i - 1]];
                              return saveBackups(next);
                            }}
                            className="rounded-full border border-[var(--color-border)] px-2 py-0.5 disabled:opacity-40"
                          >
                            ↑
                          </ActionButton>
                          <ActionButton
                            aria-label={`Remove backup ${b.model}`}
                            busyLabel="…"
                            onAction={() => saveBackups(backups.filter((_, j) => j !== i))}
                            className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-red-300"
                          >
                            Remove
                          </ActionButton>
                        </span>
                      </div>
                    ))}
                    <ActionButton
                      busyLabel="Adding…"
                      disabled={
                        !provider ||
                        !(typedModel.trim() || selectedModel) ||
                        backups.length >= 5 ||
                        busy !== null
                      }
                      onAction={() =>
                        provider
                          ? saveBackups([
                            ...backups,
                            { provider: provider.slug, model: typedModel.trim() || selectedModel },
                          ])
                          : undefined
                      }
                      className="mt-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
                    >
                      + Add the model selected above as a backup
                    </ActionButton>
                    {backupNote ? (
                      <p className="mt-1 text-[11px] text-red-300">{backupNote}</p>
                    ) : null}
                  </div>
                ) : null}
                {authenticated && keyBased ? (
                  <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                    <button
                      type="button"
                      onClick={() => setShowChangeKey((v) => !v)}
                      className="block text-left text-xs text-[var(--color-muted)]"
                    >
                      {showChangeKey ? "Hide key editor" : `Change ${provider?.name} API key…`}
                    </button>
                    {showChangeKey ? (
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={keyValue}
                          onChange={(e) => setKeyValue(e.target.value)}
                          placeholder={provider?.key_env ?? "API key"}
                          autoComplete="off"
                          className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
                        />
                        <ActionButton
                          busyLabel="Saving…"
                          disabled={!keyValue.trim() || busy !== null}
                          onAction={() => saveKey()}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3.5 py-2 text-xs disabled:opacity-60"
                        >
                          Save
                        </ActionButton>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setPhase({ kind: "confirm-disconnect" })}
                      className="block text-left text-xs text-red-300"
                    >
                      Disconnect {provider?.name} — remove its key from .env
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function describeAssignment(
  a: AuxTaskAssignment | undefined,
  main: { provider: string; model: string },
): string {
  if (!a || a.provider === "auto" || !a.provider) {
    return `auto → ${main.model || "main"}`;
  }
  return a.model || a.provider;
}

"use client";

import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import { useRefresh } from "@/components/ui/useRefresh";
import { TOOLS_MANAGE_DENIED } from "@/lib/auth/roles";
import type { McpOAuthFlowState, McpServer, Toolset } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * Settings → Tools & Integrations. Lists the MCP servers and `hermes tools`
 * toolsets for the signed-in profile, with the operational actions: enable/
 * disable, probe ("Test"), remove, and — for `auth: oauth` servers — the
 * headless OAuth re-auth flow (open the authorization URL, paste the final
 * redirect URL back). Members and viewers get the same lists read-only
 * (`canManage={false}`): no action buttons, toolset switches disabled.
 */

type TestResult = { ok: boolean; detail: string } | null;

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* ── OAuth re-auth sheet ─────────────────────────────────────────────── */

function OAuthSheet({
  server,
  onClose,
}: {
  server: McpServer;
  onClose: (completed: boolean) => void;
}) {
  const [flow, setFlow] = useState<McpOAuthFlowState | null>(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const completedRef = useRef(false);

  // Kick the flow off once, then poll until it settles.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch(
          `/api/tools/mcp/${encodeURIComponent(server.name)}/oauth/status`,
          { cache: "no-store" },
        );
        if (res.ok && !cancelled) {
          const state = (await res.json()) as McpOAuthFlowState;
          setFlow(state);
          if (state.status === "success") completedRef.current = true;
          if (state.status === "starting" || state.status === "waiting_user") {
            timer = setTimeout(poll, 1500);
          }
        }
      } catch {
        /* keep polling — transient blips mustn't kill an in-flight flow */
        if (!cancelled) timer = setTimeout(poll, 1500);
      }
    }

    void (async () => {
      const res = await postJson(
        `/api/tools/mcp/${encodeURIComponent(server.name)}/oauth/start`,
        {},
      );
      if (!res.ok) {
        setNote(await detailOf(res));
      }
      void poll();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [server.name]);

  // Stop the page behind the sheet from scrolling (same as ConfirmDialog).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  async function submitRedirect() {
    if (!redirectUrl.trim() || submitting) return;
    setSubmitting(true);
    setNote(null);
    try {
      const res = await postJson(
        `/api/tools/mcp/${encodeURIComponent(server.name)}/oauth/redirect`,
        { url: redirectUrl.trim() },
      );
      if (!res.ok) setNote(await detailOf(res));
      else setNote("Redirect received — finishing…");
    } catch {
      setNote("Could not deliver the redirect URL.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (
      flow &&
      (flow.status === "starting" || flow.status === "waiting_user")
    ) {
      await postJson(
        `/api/tools/mcp/${encodeURIComponent(server.name)}/oauth/cancel`,
        {},
      ).catch(() => {});
    }
    onClose(completedRef.current);
  }

  const waiting = flow?.status === "waiting_user";
  const settled =
    flow?.status === "success" ||
    flow?.status === "error" ||
    flow?.status === "cancelled";

  return (
    <div
      data-component="OAuthSheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Re-authenticate ${server.name}`}
    >
      <div className="w-full max-w-md rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:rounded-2xl">
        <h3 className="text-sm font-semibold">
          Re-authenticate {server.name}
        </h3>

        {flow?.status === "starting" || !flow ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <Spinner /> Starting the sign-in flow…
          </p>
        ) : null}

        {waiting && flow?.authorization_url ? (
          <div className="mt-3 space-y-3 text-sm">
            <p className="text-[var(--color-muted)]">
              1. Open the provider&apos;s sign-in page and approve access:
            </p>
            <a
              href={flow.authorization_url}
              target="_blank"
              rel="noreferrer"
              className="block break-all rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-accent)] underline"
            >
              Open authorization page
            </a>
            <p className="text-[var(--color-muted)]">
              2. After approving, the browser will try to open a{" "}
              <code>127.0.0.1</code> address that fails to load — that&apos;s
              expected on a headless box. Copy the full URL from the address
              bar and paste it here:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={redirectUrl}
                onChange={(e) => setRedirectUrl(e.target.value)}
                placeholder="http://127.0.0.1:…/callback?code=…&state=…"
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs"
              />
              <ActionButton busyLabel="Sending…"
                onAction={() => submitRedirect()}
                disabled={submitting || !redirectUrl.trim()}
                className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Complete"}
              </ActionButton>
            </div>
          </div>
        ) : null}

        {flow?.status === "success" ? (
          <p className="mt-3 text-sm text-emerald-400">
            Signed in —{" "}
            {flow.tools ? `${flow.tools} tool(s) available.` : "token stored."}
          </p>
        ) : null}
        {flow?.status === "error" ? (
          <p className="mt-3 text-sm text-red-400">
            {flow.error ?? "The sign-in flow failed."}
          </p>
        ) : null}
        {flow?.status === "cancelled" ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">Cancelled.</p>
        ) : null}
        {note ? (
          <p className="mt-3 text-xs text-[var(--color-muted)]">{note}</p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          {settled ? (
            <button
              type="button"
              onClick={() => onClose(completedRef.current)}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs font-medium"
            >
              Done
            </button>
          ) : (
            <ActionButton
              onAction={() => cancel()}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs font-medium"
            >
              Cancel
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Server row ──────────────────────────────────────────────────────── */

function McpServerRow({
  server,
  pending,
  onAction,
  testResult,
  readOnly,
}: {
  server: McpServer;
  pending: string | null;
  onAction: (action: string) => unknown;
  testResult: TestResult;
  readOnly: boolean;
}) {
  const endpoint =
    server.url ??
    [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  const busy = pending !== null;
  return (
    <li
      data-component="McpServerRow"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{server.name}</span>
        <Pill tone={server.enabled ? "success" : "muted"}>
          {server.enabled ? "enabled" : "disabled"}
        </Pill>
        <Pill tone="muted">{server.transport}</Pill>
        {server.auth === "oauth" ? (
          <Pill tone={server.oauth_token_present ? "success" : "warning"}>
            {server.oauth_token_present ? "signed in" : "needs auth"}
          </Pill>
        ) : null}
      </div>
      <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
        {endpoint}
      </p>
      {testResult ? (
        <p
          className={`mt-2 text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}
        >
          {testResult.detail}
        </p>
      ) : null}
      {readOnly ? null : (
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton busyLabel="Testing…"
          disabled={busy}
          onAction={() => onAction("test")}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {pending === "test" ? "Testing…" : "Test connection"}
        </ActionButton>
        {server.auth === "oauth" ? (
          <ActionButton
            disabled={busy}
            onAction={() => onAction("reauth")}
            className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Re-authenticate
          </ActionButton>
        ) : null}
        <ActionButton
          disabled={busy}
          onAction={() => onAction(server.enabled ? "disable" : "enable")}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {server.enabled ? "Disable" : "Enable"}
        </ActionButton>
        <ActionButton
          disabled={busy}
          onAction={() => onAction("remove")}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 disabled:opacity-50"
        >
          Remove
        </ActionButton>
      </div>
      )}
    </li>
  );
}

function ToolsetRow({
  toolset,
  pending,
  onToggle,
  readOnly,
}: {
  toolset: Toolset;
  pending: boolean;
  onToggle: (enabled: boolean) => unknown;
  readOnly: boolean;
}) {
  return (
    <li
      data-component="ToolsetRow"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{toolset.label}</span>
        <Pill tone={toolset.enabled ? "success" : "muted"}>
          {toolset.enabled ? "enabled" : "disabled"}
        </Pill>
        {!toolset.configured ? <Pill tone="warning">needs setup</Pill> : null}
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {toolset.description}
      </p>
      {toolset.tools.length > 0 ? (
        <p className="mt-1 break-words text-xs text-[var(--color-muted)]">
          Tools: {toolset.tools.join(", ")}
        </p>
      ) : null}
      <div className="mt-3">
        <ActionButton
          disabled={pending || readOnly}
          title={readOnly ? TOOLS_MANAGE_DENIED : undefined}
          onAction={() => onToggle(!toolset.enabled)}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {toolset.enabled ? "Disable" : "Enable"}
        </ActionButton>
      </div>
    </li>
  );
}

/* ── Section ─────────────────────────────────────────────────────────── */

export function ToolsSettings({
  servers,
  toolsets,
  canManage = true,
}: {
  servers: McpServer[];
  toolsets: Toolset[];
  /** Owner/admin may change settings; members and viewers only see them. */
  canManage?: boolean;
}) {
  const readOnly = !canManage;
  const { refresh, refreshing } = useRefresh();
  // The server action completes before the refreshed props land; hold the
  // row's busy state across the refresh so a second tap can't double-fire.
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [oauthFor, setOauthFor] = useState<McpServer | null>(null);
  const [tsPending, setTsPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = servers;
  const tsets = toolsets;
  const enabledGroups = tsets.filter((t) => t.enabled);

  function busyKey(name: string) {
    return pending[name] ?? (refreshing ? "refresh" : null);
  }

  async function mcpAction(name: string, action: string) {
    if (readOnly) return;
    if (action === "reauth") {
      setOauthFor(rows.find((s) => s.name === name) ?? null);
      return;
    }
    if (action === "remove") {
      setRemoving(rows.find((s) => s.name === name) ?? null);
      return;
    }
    if (busyKey(name)) return;
    setPending((p) => ({ ...p, [name]: action }));
    setError(null);
    try {
      if (action === "test") {
        const res = await postJson(
          `/api/tools/mcp/${encodeURIComponent(name)}/test`,
          {},
        );
        const body = (await res.json()) as {
          ok?: boolean;
          tools?: { name: string }[];
          error?: string;
          detail?: string;
        };
        setTestResults((r) => ({
          ...r,
          [name]: res.ok && body.ok
            ? { ok: true, detail: `Connected — ${body.tools?.length ?? 0} tool(s) listed.` }
            : {
                ok: false,
                detail: body.error ?? body.detail ?? "Probe failed.",
              },
        }));
      } else {
        // enable / disable
        const res = await postJson(
          `/api/tools/mcp/${encodeURIComponent(name)}/enabled`,
          { enabled: action === "enable" },
        );
        if (!res.ok) setError(await detailOf(res));
        refresh();
      }
    } catch {
      setError("The AI layer could not be reached.");
    } finally {
      setPending((p) => ({ ...p, [name]: null }));
    }
  }

  async function confirmRemove() {
    const name = removing?.name;
    if (!name) return;
    setPending((p) => ({ ...p, [name]: "remove" }));
    setRemoving(null);
    try {
      const res = await fetch(`/api/tools/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) setError(await detailOf(res));
      refresh();
    } catch {
      setError("The AI layer could not be reached.");
    } finally {
      setPending((p) => ({ ...p, [name]: null }));
    }
  }

  async function toggleToolset(name: string, enabled: boolean) {
    if (readOnly || tsPending || refreshing) return;
    setTsPending(name);
    setError(null);
    try {
      const res = await postJson(
        `/api/tools/toolsets/${encodeURIComponent(name)}`,
        { enabled },
      );
      if (!res.ok) setError(await detailOf(res));
      refresh();
    } catch {
      setError("The AI layer could not be reached.");
    } finally {
      setTsPending(null);
    }
  }

  return (
    <div data-component="ToolsSettings" className="space-y-6">
      {readOnly ? (
        <p
          data-testid="tools-read-only-note"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-muted)]"
        >
          You can see what the agent can use here. {TOOLS_MANAGE_DENIED}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold">MCP servers</h2>
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          Remote and local MCP integrations the agent connects to. Changes take
          effect on the next connection; &ldquo;Test connection&rdquo; probes
          the server now.
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No MCP servers configured for this profile.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((server) => (
              <McpServerRow
                key={server.name}
                server={server}
                pending={busyKey(server.name)}
                testResult={testResults[server.name] ?? null}
                readOnly={readOnly}
                onAction={(action) => mcpAction(server.name, action)}
              />
            ))}
          </ul>
        )}
      </section>

      <section data-component="ChatToolGroups">
        <h2 className="text-sm font-semibold">Tool groups for Aquarium chats</h2>
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Turn groups of tools on or off for Aquarium chats. Changes apply to
          new chats; a chat that is already open keeps the tools it started
          with. &ldquo;needs setup&rdquo; means the group needs an API key or
          account (add it under Connected accounts).
        </p>
        {tsets.length > 0 ? (
          <p
            data-testid="chat-tool-groups-on"
            className="mb-3 text-xs text-[var(--color-muted)]"
          >
            {enabledGroups.length > 0
              ? `New chats can use: ${enabledGroups.map((t) => t.label).join(", ")}.`
              : "No tool groups are on — new chats get no tools from this list."}
          </p>
        ) : null}
        {tsets.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No tool groups to configure.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tsets.map((toolset) => (
              <ToolsetRow
                key={toolset.name}
                toolset={toolset}
                pending={tsPending === toolset.name || refreshing}
                readOnly={readOnly}
                onToggle={(enabled) => toggleToolset(toolset.name, enabled)}
              />
            ))}
          </ul>
        )}
      </section>

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body="The server's entry is deleted from the profile config. Enabled skills or playbooks that rely on its tools will stop working until it's re-added."
          confirmLabel="Remove"
          busy={pending[removing.name] === "remove"}
          onConfirm={() => confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      ) : null}

      {oauthFor ? (
        <OAuthSheet
          server={oauthFor}
          onClose={(completed) => {
            setOauthFor(null);
            if (completed) refresh();
          }}
        />
      ) : null}
    </div>
  );
}

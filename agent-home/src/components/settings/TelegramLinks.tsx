"use client";

/**
 * Inline Telegram linkage manager for Settings › In&Out.
 *
 * The Telegram bot itself lives in the gateway config; what an owner/admin
 * decides here is *who* it recognises: each enrolled member may have any
 * number of Telegram user ids linked, and messages from unlinked ids are
 * treated as anonymous. Linking and unlinking happen in place through the
 * member-channel BFF routes (`POST`/`DELETE /api/comms/members/{id}/channels`).
 *
 * Linking an id that already belongs to another member re-points it (the
 * store upserts on `(platform, channel_user_id)`), which the UI says up front.
 */

import { useCallback, useEffect, useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import type { Member, MembersResponse } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";

const PLATFORM = "telegram";
const PREFIX = `${PLATFORM}:`;

/** Telegram user ids linked to a member, from its `platform:id` channel list. */
export function telegramIds(channels: readonly string[]): string[] {
  return channels
    .filter((c) => c.startsWith(PREFIX))
    .map((c) => c.slice(PREFIX.length));
}

type Busy = { userId: string; action: "link" | "unlink"; id: string } | null;

export function TelegramLinks({
  canManage = true,
}: {
  canManage?: boolean;
} = {}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    fetchRoster().then(
      (body) => {
        if (cancelled) return;
        setLoadError(null);
        setConfigured(body.configured);
        setMembers(body.members.filter((m) => m.enrolled));
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setMembers([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [canManage, reloadKey]);

  function applyChannels(userId: string, channels: string[]) {
    setMembers((prev) =>
      prev
        ? prev.map((m) => (m.user_id === userId ? { ...m, channels } : m))
        : prev,
    );
  }

  async function link(member: Member) {
    const id = (drafts[member.user_id] ?? "").trim();
    if (!id || busy) return;
    if (!/^\d+$/.test(id)) {
      setNotice({
        kind: "error",
        text: "A Telegram user id is numeric (e.g. 8756039695) — not a @username.",
      });
      return;
    }
    setBusy({ userId: member.user_id, action: "link", id });
    setNotice(null);
    try {
      const res = await fetch(
        `/api/comms/members/${encodeURIComponent(member.user_id)}/channels`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ platform: PLATFORM, channel_user_id: id }),
        },
      );
      if (!res.ok) throw new Error(await friendlyError(res));
      const body = (await res.json()) as { member: { channels: string[] } };
      applyChannels(member.user_id, body.member.channels);
      // The same id can only point at one member; drop it from anyone else.
      setMembers((prev) =>
        prev
          ? prev.map((m) =>
              m.user_id === member.user_id
                ? m
                : {
                    ...m,
                    channels: m.channels.filter((c) => c !== `${PREFIX}${id}`),
                  },
            )
          : prev,
      );
      setDrafts((d) => ({ ...d, [member.user_id]: "" }));
      setNotice({
        kind: "ok",
        text: `Telegram ${id} now reaches Hermes as ${member.display || member.user_id}.`,
      });
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  async function unlink(member: Member, id: string) {
    if (busy) return;
    setBusy({ userId: member.user_id, action: "unlink", id });
    setNotice(null);
    try {
      const query = new URLSearchParams({
        platform: PLATFORM,
        channel_user_id: id,
      });
      const res = await fetch(
        `/api/comms/members/${encodeURIComponent(member.user_id)}/channels?${query}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(await friendlyError(res));
      const body = (await res.json()) as { member: { channels: string[] } };
      applyChannels(member.user_id, body.member.channels);
      setNotice({
        kind: "ok",
        text: `Telegram ${id} unlinked; its messages are anonymous again.`,
      });
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  const { run: linkOnce } = useAction(link);

  return (
    <section data-component="TelegramLinks" data-section="telegram">
      <h2 className="text-sm font-semibold">Telegram</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Which Telegram accounts Hermes recognises. Link a member&apos;s numeric
        Telegram user id (send <code>/start</code> to <code>@userinfobot</code>{" "}
        to see yours); messages from unlinked ids are treated as anonymous.
        Linking an id that belongs to someone else moves it to the new member.
      </p>

      {!canManage ? (
        <p className="text-xs text-[var(--color-muted)]">
          Only the owner or an admin can change Telegram links.
        </p>
      ) : members === null ? (
        <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <Spinner /> Loading members…
        </p>
      ) : loadError ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          Could not load members: {loadError}{" "}
          <ActionButton className="underline" onAction={load}>
            Retry
          </ActionButton>
        </p>
      ) : !configured ? (
        <p className="text-xs text-[var(--color-muted)]">
          Member administration is not configured on this Hermes.
        </p>
      ) : members.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">No enrolled members.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {members.map((m) => {
            const ids = telegramIds(m.channels);
            const rowBusy = busy?.userId === m.user_id;
            const draft = drafts[m.user_id] ?? "";
            return (
              <li
                key={m.user_id}
                data-member={m.user_id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {m.display || m.user_id}
                    <span className="ml-2 text-xs text-[var(--color-muted)]">
                      {m.role}
                      {m.active ? "" : " · deactivated"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {ids.length === 0 ? (
                      <span className="text-xs text-[var(--color-muted)]">
                        No Telegram linked
                      </span>
                    ) : (
                      ids.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-xs"
                        >
                          {id}
                          <ActionButton
                            aria-label={`Unlink Telegram ${id}`}
                            title="Unlink"
                            disabled={busy !== null}
                            onAction={() => unlink(m, id)}
                            className="text-[var(--color-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
                          >
                            {rowBusy &&
                            busy?.action === "unlink" &&
                            busy.id === id ? (
                              <Spinner />
                            ) : (
                              "×"
                            )}
                          </ActionButton>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void linkOnce(m);
                  }}
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Telegram user id"
                    aria-label={`Telegram user id for ${m.display || m.user_id}`}
                    value={draft}
                    disabled={busy !== null}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [m.user_id]: e.target.value }))
                    }
                    className="w-40 rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || draft.trim() === ""}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    {rowBusy && busy?.action === "link" ? (
                      <span className="inline-flex items-center gap-1">
                        <Spinner /> Linking…
                      </span>
                    ) : (
                      "Link"
                    )}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`mt-2 text-xs ${
            notice.kind === "error"
              ? "text-[var(--color-danger)]"
              : "text-[var(--color-muted)]"
          }`}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

async function fetchRoster(): Promise<MembersResponse> {
  const res = await fetch("/api/comms/members?limit=200");
  if (!res.ok) throw new Error(await friendlyError(res));
  return (await res.json()) as MembersResponse;
}

async function friendlyError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown; error?: unknown };
    const detail = body.detail ?? body.error;
    if (typeof detail === "string" && detail) return detail;
  } catch {
    // Non-JSON body — fall through to the status line.
  }
  return `${res.status} ${res.statusText}`.trim();
}

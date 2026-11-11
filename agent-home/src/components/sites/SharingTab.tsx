"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { dangerButtonClass, inputClass } from "@/components/ui/Sheet";
import { useServerState } from "@/components/ui/useRefresh";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { DirectoryEntry } from "@/types";
import type { SiteAccess, SiteGrant } from "@/types/sites";

import { JSON_HEADERS, personName, readJson, sitePath } from "./format";

/** Sharing: the owner, every grant (read / admin) and revoke. Admins only. */
export function SharingTab({
  siteId,
  ownerId,
  grants: initialGrants,
  directory,
  me,
}: {
  siteId: string;
  ownerId: string;
  grants: SiteGrant[];
  directory: DirectoryEntry[];
  me: string;
}) {
  const t = useT("sites");
  const [grants, setGrants] = useServerState(initialGrants);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [level, setLevel] = useState<SiteAccess>("read");
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const candidates = directory.filter((p) => p.user_id !== ownerId && !grants.some((g) => g.user_id === p.user_id));

  async function put(user_id: string, grant: SiteAccess) {
    setError(null);
    try {
      const { grant: saved } = await readJson<{ grant: SiteGrant }>(
        await fetch(sitePath(siteId, "grants"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ user_id, grant }),
        }),
      );
      setGrants((prev) => [...prev.filter((g) => g.user_id !== user_id), saved]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
  const change = useAction(put);

  async function revoke(user_id: string) {
    setError(null);
    try {
      await readJson(
        await fetch(`${sitePath(siteId, "grants")}?${new URLSearchParams({ user_id })}`, { method: "DELETE" }),
      );
      setGrants((prev) => prev.filter((g) => g.user_id !== user_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setRevoking(null);
  }

  return (
    <div data-component="SharingTab" className="space-y-4">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <ul className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <li className="flex items-center gap-2 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {personName(people, ownerId)}
            {ownerId === me ? ` (${t("list.you")})` : ""}
          </span>
          <Pill tone="accent">{t("sharing.owner")}</Pill>
        </li>
        {grants.map((g) => (
          <li key={g.user_id} data-grant={g.user_id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{personName(people, g.user_id)}</span>
            <select
              aria-label={t("sharing.levelFor", { who: personName(people, g.user_id) })}
              className={`${inputClass} w-auto`}
              value={g.grant}
              disabled={change.pending}
              onChange={(e) => void change.run(g.user_id, e.target.value as SiteAccess)}
            >
              <option value="read">{t("access.read")}</option>
              <option value="admin">{t("access.admin")}</option>
            </select>
            <button type="button" className={dangerButtonClass} onClick={() => setRevoking(g.user_id)}>
              {t("sharing.revoke")}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--color-muted)]">{t("sharing.levels")}</p>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <select
          aria-label={t("sharing.person")}
          className={`${inputClass} w-auto min-w-[12rem] flex-1`}
          value={who}
          onChange={(e) => setWho(e.target.value)}
        >
          <option value="">{candidates.length ? t("sharing.pick") : t("sharing.nobody")}</option>
          {candidates.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.display || p.user_id}
            </option>
          ))}
        </select>
        <select
          aria-label={t("sharing.level")}
          className={`${inputClass} w-auto`}
          value={level}
          onChange={(e) => setLevel(e.target.value as SiteAccess)}
        >
          <option value="read">{t("access.read")}</option>
          <option value="admin">{t("access.admin")}</option>
        </select>
        <ActionButton
          disabled={!who}
          onAction={async () => {
            if (await put(who, level)) setWho("");
          }}
          className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {t("sharing.grant")}
        </ActionButton>
      </div>
      {revoking ? (
        <ConfirmDialog
          title={t("sharing.revokeTitle", { who: personName(people, revoking) })}
          body={t("sharing.revokeBody")}
          confirmLabel={t("sharing.revoke")}
          onConfirm={() => revoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </div>
  );
}

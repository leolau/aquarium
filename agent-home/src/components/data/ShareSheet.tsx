"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { Sheet, dangerButtonClass, inputClass, primaryButtonClass } from "@/components/ui/Sheet";
import { personName, readJson, JSON_HEADERS } from "@/components/sites/format";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { DirectoryEntry } from "@/types";
import type { DataGrant, DataGrantLevel } from "@/types/data";

import { dataPath } from "./format";

/** Figma "Share dialog" / phone share sheet: owner, admins note, each grant and revoke. */
export function ShareSheet({
  sourceId,
  ownerId,
  directory,
  directoryError = false,
  onClose,
}: {
  sourceId: string;
  ownerId: string;
  directory: DirectoryEntry[];
  /** The people list couldn't be loaded, so nobody can be picked (not "everyone has access"). */
  directoryError?: boolean;
  onClose(): void;
}) {
  const t = useT("data");
  const [grants, setGrants] = useState<DataGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [level, setLevel] = useState<DataGrantLevel>("read");
  const [revoking, setRevoking] = useState<string | null>(null);
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));

  useEffect(() => {
    let live = true;
    fetch(dataPath(sourceId, "grants"))
      .then((r) => readJson<{ grants: DataGrant[] }>(r))
      .then((doc) => live && setGrants(doc.grants))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [sourceId]);

  async function put(user_id: string, grant: DataGrantLevel) {
    setError(null);
    try {
      const { grant: saved } = await readJson<{ grant: DataGrant }>(
        await fetch(dataPath(sourceId, "grants"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ user_id, grant }) }),
      );
      setGrants((prev) => [...(prev ?? []).filter((g) => g.user_id !== user_id), saved]);
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
      await readJson(await fetch(`${dataPath(sourceId, "grants")}?${new URLSearchParams({ user_id })}`, { method: "DELETE" }));
      setGrants((prev) => (prev ?? []).filter((g) => g.user_id !== user_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setRevoking(null);
  }

  const taken = new Set([ownerId, ...(grants ?? []).map((g) => g.user_id)]);
  const candidates = directory.filter((p) => !taken.has(p.user_id) && p.role !== "owner" && p.role !== "admin");

  return (
    <Sheet title={t("share.title")} onClose={onClose} component="DataShareSheet">
      <div className="space-y-4">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {directoryError ? <InlineAlert tone="warn">{t("share.directoryError")}</InlineAlert> : null}
        <p className="text-sm text-[var(--color-muted)]">{t("share.always")}</p>
        <ul className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)]">
          {ownerId ? (
            <li className="flex items-center gap-2 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{personName(people, ownerId)}</span>
              <Pill tone="accent">{t("share.owner")}</Pill>
            </li>
          ) : null}
          {grants === null && !error ? <li className="px-4 py-3 text-sm text-[var(--color-muted)]">{t("share.loading")}</li> : null}
          {(grants ?? []).map((g) => (
            <li key={g.user_id} data-grant={g.user_id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{personName(people, g.user_id)}</span>
              <select
                aria-label={t("share.levelFor", { who: personName(people, g.user_id) })}
                className={`${inputClass} w-auto`}
                value={g.grant}
                disabled={change.pending}
                onChange={(e) => void change.run(g.user_id, e.target.value as DataGrantLevel)}
              >
                <option value="read">{t("access.read")}</option>
                <option value="propose">{t("access.propose")}</option>
              </select>
              <button type="button" className={dangerButtonClass} onClick={() => setRevoking(g.user_id)}>
                {t("share.remove")}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("share.person")}
            className={`${inputClass} w-auto min-w-[12rem] flex-1`}
            value={who}
            onChange={(e) => setWho(e.target.value)}
          >
            <option value="">{directoryError ? t("share.unavailable") : candidates.length ? t("share.pick") : t("share.nobody")}</option>
            {candidates.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.display || p.user_id}
              </option>
            ))}
          </select>
          <select aria-label={t("share.level")} className={`${inputClass} w-auto`} value={level} onChange={(e) => setLevel(e.target.value as DataGrantLevel)}>
            <option value="read">{t("access.read")}</option>
            <option value="propose">{t("access.propose")}</option>
          </select>
          <ActionButton
            disabled={!who}
            busyLabel={t("share.adding")}
            className={primaryButtonClass}
            onAction={async () => {
              if (await put(who, level)) setWho("");
            }}
          >
            {t("share.add")}
          </ActionButton>
        </div>
        <p className="text-xs text-[var(--color-muted)]">{t("share.levels")}</p>
      </div>
      {revoking ? (
        <ConfirmDialog
          title={t("share.removeTitle", { who: personName(people, revoking) })}
          body={t("share.removeBody")}
          confirmLabel={t("share.remove")}
          onConfirm={() => revoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </Sheet>
  );
}

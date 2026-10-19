"use client";

import Link from "next/link";
import { useState } from "react";

import { ResizableTable } from "@/components/get-ready/ResizableTable";
import { useT, type T } from "@/components/get-ready/i18n";
import { CreateUserForm } from "@/components/users/CreateUserForm";
import { InvitationLink } from "@/components/users/InvitationLink";
import { errorMessage, sendJson } from "@/components/users/api";
import type {
  GetReadyConnectionCell,
  GetReadyPeopleResponse,
  MemberCreateResponse,
  Role,
} from "@/types";

export const ROLE_IDS = ["owner", "admin", "member", "viewer"] as const;

const CELL_CLASS: Record<GetReadyConnectionCell["state"], string> = {
  set: "text-emerald-300",
  waiting: "text-[var(--color-warn-text)]",
  not_set: "text-[var(--color-muted)]",
  coming: "text-[var(--color-muted)] italic",
};

export function cellText(t: T, cell: GetReadyConnectionCell): string {
  if (cell.state === "waiting") return t(`cell.waiting.${cell.reason ?? "qr"}`);
  if (cell.state === "set" && typeof cell.count === "number" && cell.count > 0) {
    return t("cell.tools", { count: cell.count });
  }
  return t(`cell.${cell.state}`);
}

/** Screen 2b: what each role can do, invite someone, each person's connections. */
export function PeopleAndRoles({
  profile,
  people,
  peopleError,
}: {
  profile: string;
  people: GetReadyPeopleResponse | null;
  peopleError: string | null;
}) {
  const t = useT("getReady");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ label: string; path: string; expiresAt: string | null } | null>(
    null,
  );

  async function invite(input: { email: string; profile: string; display: string; role: Role }) {
    setBusy(true);
    setNotice(null);
    try {
      const resp = await sendJson<MemberCreateResponse>("/api/comms/members", "POST", input);
      if (resp.activation_path) {
        setLink({
          label: input.email,
          path: resp.activation_path,
          expiresAt: resp.invitation?.expires_at ?? null,
        });
      } else {
        setNotice(resp.enrolled_existing ? input.email : resp.member.user_id);
      }
    } catch (err) {
      setNotice(errorMessage(err, "Invite failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-component="PeopleAndRoles" className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("roles.heading")}</h3>
        <div className="hidden md:block">
          <ResizableTable
            label={t("roles.heading")}
            columns={[t("roles.col.role"), t("roles.col.for"), t("roles.col.can"), t("roles.col.cannot")]}
            initialWidths={[110, 160, 300, 300]}
          >
            {ROLE_IDS.map((role) => (
              <tr key={role} className="border-t border-[var(--color-border)] align-top">
                <td className="px-3 py-2 font-medium">{t(`role.${role}`)}</td>
                <td className="px-3 py-2 text-[var(--color-muted)]">{t(`role.${role}.for`)}</td>
                <td className="px-3 py-2">{t(`role.${role}.can`)}</td>
                <td className="px-3 py-2 text-[var(--color-muted)]">{t(`role.${role}.cannot`)}</td>
              </tr>
            ))}
          </ResizableTable>
        </div>
        <ul className="space-y-2 md:hidden">
          {ROLE_IDS.map((role) => (
            <li
              key={role}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
            >
              <p className="font-medium">
                {t(`role.${role}`)}{" "}
                <span className="font-normal text-[var(--color-muted)]">· {t(`role.${role}.for`)}</span>
              </p>
              <p className="mt-1">
                <span className="text-emerald-300">{t("roles.canLabel")}</span> {t(`role.${role}.can`)}
              </p>
              <p className="mt-1 text-[var(--color-muted)]">
                <span className="text-[var(--color-warn-text)]">{t("roles.cannotLabel")}</span>{" "}
                {t(`role.${role}.cannot`)}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-[var(--color-muted)]">{t("roles.note")}</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("invite.heading")}</h3>
        <CreateUserForm profile={profile} busy={busy} disabled={busy} onCreate={invite} />
        {link ? (
          <InvitationLink
            label={link.label}
            path={link.path}
            expiresAt={link.expiresAt}
            onDismiss={() => setLink(null)}
          />
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-[var(--color-muted)]">
            {notice}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("people.heading")}</h3>
        <p className="text-xs text-[var(--color-muted)]">{t("people.note")}</p>
        {peopleError || !people ? (
          <p className="text-sm text-[var(--color-muted)]">{t("people.loadFailed")}</p>
        ) : (
          <>
            <div className="hidden md:block">
              <ResizableTable
                label={t("people.heading")}
                columns={[
                  t("people.col.person"),
                  ...people.connections.map((c) => t(`conn.${c}`)),
                ]}
                initialWidths={[200, ...people.connections.map(() => 120)]}
              >
                {people.people.map((person) => (
                  <tr key={person.user_id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2">
                      <span className="font-medium">{person.display}</span>{" "}
                      <span className="text-xs text-[var(--color-muted)]">
                        {t(`role.${person.role}`)}
                        {person.is_you ? ` · ${t("people.you")}` : ""}
                        {person.invited_pending ? ` · ${t("people.invited")}` : ""}
                      </span>
                    </td>
                    {people.connections.map((c) => (
                      <td key={c} className={`px-3 py-2 ${CELL_CLASS[person.connections[c].state]}`}>
                        {cellText(t, person.connections[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </ResizableTable>
            </div>
            <ul className="space-y-2 md:hidden">
              {people.people.map((person) => (
                <li
                  key={person.user_id}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
                >
                  <p>
                    <span className="font-medium">{person.display}</span>{" "}
                    <span className="text-xs text-[var(--color-muted)]">
                      {t(`role.${person.role}`)}
                      {person.is_you ? ` · ${t("people.you")}` : ""}
                      {person.invited_pending ? ` · ${t("people.invited")}` : ""}
                    </span>
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {people.connections.map((c) => (
                      <div key={c} className="flex justify-between gap-2">
                        <dt className="text-[var(--color-muted)]">{t(`conn.${c}`)}</dt>
                        <dd className={CELL_CLASS[person.connections[c].state]}>
                          {cellText(t, person.connections[c])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[var(--color-muted)]">
              {t("people.reminderNote")}{" "}
              <Link href="/users" className="text-[var(--color-accent)] underline">
                {t("people.openUsers")}
              </Link>
            </p>
          </>
        )}
      </section>
    </div>
  );
}

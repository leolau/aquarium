"use client";

import { useState } from "react";

import { PeopleAndRoles } from "@/components/get-ready/PeopleAndRoles";
import { formatWhen, useLocale, useT, type T } from "@/components/get-ready/i18n";
import { NetworkFolders } from "@/components/files/NetworkFolders";
import { ModelPickerSheet } from "@/components/models/ModelPickerSheet";
import { AccountSecurity } from "@/components/account/AccountSecurity";
import { SecurityBasicsItem } from "@/components/get-ready/SecurityBasicsItem";
import { GoogleClientSetup } from "@/components/settings/GoogleClientSetup";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { TelegramLinks } from "@/components/settings/TelegramLinks";
import { ToolsSettings } from "@/components/settings/ToolsSettings";
import { VpnConnections } from "@/components/settings/VpnConnections";
import { WhatsAppBridges } from "@/components/settings/WhatsAppBridges";
import { Spinner } from "@/components/ui/Spinner";
import { sendJson } from "@/components/users/api";
import type {
  GetReadyGroup,
  GetReadyItem,
  GetReadyPeopleResponse,
  GetReadyResponse,
  GetReadyStatus,
  McpServer,
  Toolset,
} from "@/types";

const GROUPS: GetReadyGroup[] = ["basics", "connections", "safety"];

const STATUS_PILL: Record<GetReadyStatus, string> = {
  done: "bg-emerald-500/15 text-emerald-300",
  attention: "bg-amber-500/15 text-[var(--color-warn-text)]",
  not_started: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};

const STATUS_DOT: Record<GetReadyStatus, string> = {
  done: "bg-emerald-500 text-white",
  attention: "bg-amber-500 text-black",
  not_started: "border border-[var(--color-border)] text-[var(--color-muted)]",
};

const TEST_TONE = { ok: "text-emerald-300", warn: "text-[var(--color-warn-text)]", bad: "text-red-300" };

export interface GetReadyExtras {
  profile: string;
  people: GetReadyPeopleResponse | null;
  peopleError: string | null;
  tools: { servers: McpServer[]; toolsets: Toolset[] } | null;
  currentMain: { provider: string; model: string } | null;
}

export function summarize(items: GetReadyItem[]): GetReadyResponse["summary"] {
  const count = (status: GetReadyStatus) => items.filter((i) => i.status === status).length;
  return {
    total: items.length,
    done: count("done"),
    attention: count("attention"),
    not_started: count("not_started"),
  };
}

/** Settings → Get ready: the P2 checklist with inline set-up panels. */
export function GetReadyView({ initial, extras }: { initial: GetReadyResponse; extras: GetReadyExtras }) {
  const t = useT("getReady");
  const [items, setItems] = useState(initial.items);
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [securityRun, setSecurityRun] = useState(0);
  const summary = summarize(items);
  const isOwner = initial.role === "owner";

  function replace(next: GetReadyItem) {
    setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
  }

  async function runTest(id: string) {
    setTesting((s) => new Set(s).add(id));
    setError(null);
    try {
      replace(await sendJson<GetReadyItem>(`/api/get-ready/${id}/test`, "POST"));
    } catch {
      setError(t("testFailed"));
    } finally {
      setTesting((s) => {
        const copy = new Set(s);
        copy.delete(id);
        return copy;
      });
    }
  }

  async function testAll() {
    setTestingAll(true);
    try {
      for (const item of items) await runTest(item.id);
    } finally {
      setSecurityRun((n) => n + 1);
      setTestingAll(false);
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/get-ready", { cache: "no-store" });
      if (res.ok) setItems(((await res.json()) as GetReadyResponse).items);
    } catch {
      /* keep the last known statuses */
    }
  }

  function toggle(id: string) {
    if (open === id) void refresh();
    setOpen(open === id ? null : id);
  }

  const busyAny = testingAll || testing.size > 0;

  return (
    <div data-component="GetReadyView" className="space-y-4 lg:grid lg:grid-cols-[260px_1fr] lg:gap-6 lg:space-y-0">
      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <p className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold">{summary.done}</span>
            <span className="text-sm text-[var(--color-muted)]">{t("ofReady", { total: summary.total })}</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${summary.total ? (summary.done / summary.total) * 100 : 0}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {t("summary", { attention: summary.attention, notStarted: summary.not_started })}
          </p>
          <button
            type="button"
            onClick={() => void testAll()}
            disabled={busyAny}
            aria-busy={testingAll}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {testingAll ? (
              <>
                <Spinner /> {t("testingAll", { count: items.length })}
              </>
            ) : (
              t("testAll")
            )}
          </button>
        </div>
        <nav className="hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 lg:block">
          {items.map((item) => (
            <a
              key={item.id}
              href={`#get-ready-${item.id}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]"
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${STATUS_DOT[item.status]}`}>
                {item.status === "done" ? "✓" : item.n}
              </span>
              <span className="truncate">{t(`item.${item.id}`)}</span>
            </a>
          ))}
        </nav>
      </aside>

      <div className="space-y-5">
        <p className="text-sm text-[var(--color-muted)]">
          {initial.can_manage ? t("introManager") : t("introPerson")}
        </p>
        {error ? (
          <p role="alert" className="rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.group === group);
          if (groupItems.length === 0) return null;
          return (
            <section key={group} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                {t(`group.${group}`)}
              </h2>
              <ul className="space-y-2">
                {groupItems.map((item) =>
                  item.id === "security" ? (
                    <li key={item.id} id="get-ready-security" className="scroll-mt-4">
                      <SecurityBasicsItem key={securityRun} number={item.n} />
                    </li>
                  ) : (
                  <ItemRow
                    key={item.id}
                    item={item}
                    t={t}
                    open={open === item.id}
                    testing={testing.has(item.id)}
                    disabled={testingAll}
                    onToggle={() => toggle(item.id)}
                    onTest={() => void runTest(item.id)}
                  >
                    {open === item.id ? <Panel item={item} t={t} isOwner={isOwner} canManage={initial.can_manage} extras={extras} /> : null}
                  </ItemRow>
                  ),
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  t,
  open,
  testing,
  disabled,
  onToggle,
  onTest,
  children,
}: {
  item: GetReadyItem;
  t: T;
  open: boolean;
  testing: boolean;
  disabled: boolean;
  onToggle: () => void;
  onTest: () => void;
  children: React.ReactNode;
}) {
  const locale = useLocale();
  const last = item.last_test;
  return (
    <li
      id={`get-ready-${item.id}`}
      data-component="GetReadyItemRow"
      className={`scroll-mt-4 rounded-2xl border bg-[var(--color-surface)] p-4 ${open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
    >
      <div className="flex gap-3">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${STATUS_DOT[item.status]}`}
          aria-hidden
        >
          {item.status === "done" ? "✓" : item.n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="mr-1 text-sm font-semibold">{t(`item.${item.id}`)}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_PILL[item.status]}`}>
              {t(`status.${item.status}`)}
            </span>
            <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
              {item.required ? t("required") : t("optional")}
            </span>
            {item.per_person ? (
              <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                {t("perPerson")}
              </span>
            ) : null}
            {item.coming ? (
              <span className="rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                {t("coming")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t(`d.${item.detail}`, item.params)}</p>
          <p className="text-xs text-[var(--color-muted)]" suppressHydrationWarning>
            {last ? (
              <>
                {t("lastTest", { when: formatWhen(locale, last.at) })}
                {" · "}
                <span className={TEST_TONE[last.result]}>{t(`d.${last.detail}`, last.params)}</span>
              </>
            ) : (
              t("never")
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${open ? "border border-[var(--color-border)] bg-[var(--color-surface-2)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"}`}
            >
              {open ? t("close") : t("setup")}
            </button>
            <button
              type="button"
              onClick={onTest}
              disabled={testing || disabled}
              aria-busy={testing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            >
              {testing ? (
                <>
                  <Spinner /> {t("testing")}
                </>
              ) : (
                t("test")
              )}
            </button>
          </div>
        </div>
      </div>
      {children ? <div className="mt-3 border-t border-[var(--color-border)] pt-3">{children}</div> : null}
    </li>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p data-component="GetReadyNote" className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]">
      {children}
    </p>
  );
}

function Panel({
  item,
  t,
  isOwner,
  canManage,
  extras,
}: {
  item: GetReadyItem;
  t: T;
  isOwner: boolean;
  canManage: boolean;
  extras: GetReadyExtras;
}) {
  const [picker, setPicker] = useState(false);
  switch (item.id) {
    case "owner":
      return (
        <div className="space-y-2">
          {isOwner ? null : <Note>{t("panel.ownerSelf")}</Note>}
          <AccountSecurity isOwner={isOwner} />
        </div>
      );
    case "model":
      return (
        <div data-component="GetReadyModelPanel" className="space-y-2">
          <Note>{t("panel.modelNote")}</Note>
          {extras.currentMain ? (
            <button
              type="button"
              onClick={() => setPicker(true)}
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)]"
            >
              {t("panel.modelChoose")}
            </button>
          ) : null}
          {picker && extras.currentMain ? (
            <ModelPickerSheet
              slot={{ kind: "main" }}
              currentMain={extras.currentMain}
              onClose={() => setPicker(false)}
              onChanged={() => setPicker(false)}
              onError={() => undefined}
            />
          ) : null}
        </div>
      );
    case "people":
      return <PeopleAndRoles profile={extras.profile} people={extras.people} peopleError={extras.peopleError} />;
    case "google": {
      const stepA = item.steps.find((s) => s.id === "a")?.status ?? "not_started";
      return (
        <div data-component="GetReadyGooglePanel" className="space-y-3">
          <div>
            <p className="text-sm font-medium">
              {t("d.google.stepA")}{" "}
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_PILL[stepA]}`}>{t(`status.${stepA}`)}</span>
            </p>
            {isOwner ? (
              <GoogleClientSetup />
            ) : stepA !== "done" ? (
              <Note>{t("d.google.stepAOwnerOnly")}</Note>
            ) : null}
          </div>
          <div>
            <p className="text-sm font-medium">
              {t("d.google.stepB")}{" "}
              {stepA !== "done" ? <span className="text-xs text-[var(--color-muted)]">· {t("d.google.stepBLock")}</span> : null}
            </p>
            {stepA === "done" ? <ConnectedAccounts /> : null}
          </div>
        </div>
      );
    }
    case "whatsapp":
      return isOwner ? <WhatsAppBridges /> : <Note>{t("d.whatsapp.coming")}</Note>;
    case "telegram":
      return isOwner ? <TelegramLinks canManage /> : <Note>{t("d.telegram.coming")}</Note>;
    case "email":
      return isOwner ? <ConnectedAccounts /> : <Note>{t("d.email.coming")}</Note>;
    case "tools":
      return extras.tools ? (
        <ToolsSettings servers={extras.tools.servers} toolsets={extras.tools.toolsets} canManage={canManage} />
      ) : (
        <Note>{t("loadFailed")}</Note>
      );
    case "vpn":
      return (
        <div className="space-y-4">
          <VpnConnections />
          <NetworkFolders />
        </div>
      );
    default:
      return <Note>{t("panel.comingNote")}</Note>;
  }
}

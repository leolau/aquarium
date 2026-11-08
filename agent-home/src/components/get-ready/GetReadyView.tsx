"use client";

import Link from "next/link";
import { useState } from "react";

import { PeopleAndRoles } from "@/components/get-ready/PeopleAndRoles";
import { formatWhen, useLocale, useT, type T } from "@/components/get-ready/i18n";
import { NetworkFolders } from "@/components/files/NetworkFolders";
import { ModelPickerSheet } from "@/components/models/ModelPickerSheet";
import { AccountSecurity } from "@/components/account/AccountSecurity";
import { SecurityBasicsItem } from "@/components/get-ready/SecurityBasicsItem";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { TelegramLinks } from "@/components/settings/TelegramLinks";
import { ToolsSettings } from "@/components/settings/ToolsSettings";
import { VpnConnections } from "@/components/settings/VpnConnections";
import { WhatsAppBridges } from "@/components/settings/WhatsAppBridges";
import { TelegramBotSetup } from "@/components/settings/TelegramBotSetup";
import { PersonalMcpServers } from "@/components/settings/PersonalMcpServers";
import { EmailMailboxes } from "@/components/settings/EmailMailboxes";
import { BackupsItem } from "@/components/get-ready/BackupsItem";
import { useGoogleClientT } from "@/components/settings/googleClientStrings";
import { AlertIcon, CheckIcon, ChevronRightIcon, ClockIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
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
  OffsiteBackupStatus,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

const GROUPS: GetReadyGroup[] = ["basics", "connections", "safety"];

const STATUS_PILL: Record<GetReadyStatus, string> = {
  done: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  attention: "bg-[var(--color-warn)]/15 text-[var(--color-warn-text)]",
  not_started: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};

const STATUS_ICON_TONE: Record<GetReadyStatus, string> = {
  done: "text-[var(--color-success)]",
  attention: "text-[var(--color-warn-text)]",
  not_started: "text-[var(--color-muted)]",
};

const STATUS_DOT_FILL: Record<GetReadyStatus, string> = {
  done: "bg-[var(--color-success)]",
  attention: "bg-[var(--color-warn)]",
  not_started: "bg-[var(--color-muted)]",
};

function StatusIcon({ status }: { status: GetReadyStatus }) {
  const Icon = status === "done" ? CheckIcon : status === "attention" ? AlertIcon : ClockIcon;
  return (
    <span
      aria-hidden
      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-current ${STATUS_ICON_TONE[status]}`}
    >
      <Icon size={14} />
    </span>
  );
}

const TEST_TONE = { ok: "text-[var(--color-success)]", warn: "text-[var(--color-warn-text)]", bad: "text-[var(--color-danger)]" };

export interface GetReadyExtras {
  profile: string;
  people: GetReadyPeopleResponse | null;
  peopleError: string | null;
  tools: { servers: McpServer[]; toolsets: Toolset[] } | null;
  currentMain: { provider: string; model: string } | null;
  backups?: OffsiteBackupStatus | null;
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
    <div data-component="GetReadyView" className="flex flex-col gap-5">
      <section
        data-component="GetReadySummary"
        className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xl font-semibold">
              {summary.done} {t("ofReady", { total: summary.total })}
            </p>
            <p className="mt-1 text-sm text-[var(--color-warn-text)]">
              {t("summary", { attention: summary.attention, notStarted: summary.not_started })}
            </p>
          </div>
          <ActionButton
            busyLabel={t("testingAll", { count: items.length })}
            onAction={() => testAll()}
            disabled={busyAny}
            aria-busy={testingAll}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-semibold disabled:opacity-60"
          >
            {testingAll ? (
              <>
                <Spinner /> {t("testingAll", { count: items.length })}
              </>
            ) : (
              t("testAll")
            )}
          </ActionButton>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
          <div
            className="h-full rounded-full bg-[var(--color-success)]"
            style={{ width: `${summary.total ? (summary.done / summary.total) * 100 : 0}%` }}
          />
        </div>
      </section>

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      {GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <section
            key={group}
            data-group={group}
            className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:p-5"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {t(`group.${group}`)}
            </h2>
            <ul className="mt-1 divide-y divide-[var(--color-border)]">
              {groupItems.map((item) =>
                item.id === "backups" && isOwner ? (
                  <li key={item.id} className="py-3">
                    <ul>
                      <BackupsItem initial={extras.backups ?? null} />
                    </ul>
                  </li>
                ) : item.id === "security" ? (
                  <li key={item.id} id="get-ready-security" className="scroll-mt-4 py-3">
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
                    onTest={() => runTest(item.id)}
                  >
                    {open === item.id ? (
                      <Panel item={item} t={t} isOwner={isOwner} canManage={initial.can_manage} extras={extras} />
                    ) : null}
                  </ItemRow>
                ),
              )}
            </ul>
          </section>
        );
      })}
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
  onTest: () => unknown;
  children: React.ReactNode;
}) {
  const locale = useLocale();
  const last = item.last_test;
  const primary = item.status !== "done";
  return (
    <li id={`get-ready-${item.id}`} data-component="GetReadyItemRow" className="scroll-mt-4 py-3">
      <div className="flex gap-3">
        <StatusIcon status={item.status} />
        <div className="min-w-0 flex-1 md:flex md:items-start md:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="text-sm font-semibold">{t(`item.${item.id}`)}</h3>
              <span className="text-xs text-[var(--color-muted)]">
                {item.required ? t("required") : t("optional")}
              </span>
              {item.per_person ? <span className="text-xs text-[var(--color-muted)]">{t("perPerson")}</span> : null}
              {item.coming ? (
                <span className="rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]">
                  {t("coming")}
                </span>
              ) : null}
            </div>
            <p className="mt-1 break-words text-sm text-[var(--color-muted)]">{t(`d.${item.detail}`, item.params)}</p>
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
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 md:mt-0 md:shrink-0 md:justify-end">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${STATUS_PILL[item.status]}`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_FILL[item.status]}`} />
              {t(`status.${item.status}`)}
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className={`min-h-9 rounded-[var(--radius-lg)] px-3 text-sm font-medium ${
                open
                  ? "border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                  : primary
                    ? item.status === "attention"
                      ? "bg-[var(--color-warn)] text-[var(--color-bg)]"
                      : "border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {open ? t("close") : t("setup")}
            </button>
            <ActionButton
              busyLabel={t("testing")}
              onAction={onTest}
              disabled={testing || disabled}
              aria-busy={testing}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-lg)] px-3 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-60 aria-busy:bg-[var(--color-accent)] aria-busy:text-[var(--color-accent-fg)]"
            >
              {testing ? (
                <>
                  <Spinner /> {t("testing")}
                </>
              ) : (
                t("test")
              )}
            </ActionButton>
          </div>
        </div>
      </div>
      {children ? (
        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 md:ml-10">
          {children}
        </div>
      ) : null}
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
    case "google":
      return <GooglePanel item={item} t={t} isOwner={isOwner} />;
    case "whatsapp":
      return <WhatsAppBridges />;
    case "telegram":
      return (
        <div className="space-y-4">
          <TelegramBotSetup />
          {isOwner ? <TelegramLinks canManage /> : null}
        </div>
      );
    case "email":
      return <EmailMailboxes />;
    case "backups":
      return <Note>{t("d.backups.owner_only")}</Note>;
    case "tools":
      return (
        <div className="space-y-4">
          <PersonalMcpServers />
          {canManage ? (
            extras.tools ? (
              <ToolsSettings servers={extras.tools.servers} toolsets={extras.tools.toolsets} canManage />
            ) : (
              <Note>{t("loadFailed")}</Note>
            )
          ) : null}
        </div>
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

/** Item 4: the two-part Google stepper. Step A (owner, once) has its own page. */
function GooglePanel({ item, t, isOwner }: { item: GetReadyItem; t: T; isOwner: boolean }) {
  const gt = useGoogleClientT();
  const stepA = item.steps.find((s) => s.id === "a")?.status ?? "not_started";
  const aDone = stepA === "done";
  const chip = (done: boolean, label: string, current: boolean) => (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${
        done
          ? "bg-[var(--color-success)] text-[var(--color-bg)]"
          : current
            ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
            : "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
      }`}
    >
      {done ? <CheckIcon size={12} /> : label}
    </span>
  );
  return (
    <div data-component="GetReadyGooglePanel" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        <li className="flex items-start gap-3">
          {chip(aDone, "A", !aDone)}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {t("d.google.stepA")}
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_PILL[stepA]}`}>{t(`status.${stepA}`)}</span>
            </p>
            {isOwner ? (
              aDone ? null : (
                <Link
                  href="/settings/in-out/google"
                  className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-3 text-sm font-semibold text-[var(--color-accent-fg)]"
                >
                  {gt("openStepA")}
                  <ChevronRightIcon size={14} aria-hidden />
                </Link>
              )
            ) : aDone ? null : (
              <Note>{t("d.google.stepAOwnerOnly")}</Note>
            )}
          </div>
        </li>
        <li className="flex items-start gap-3">
          {chip(false, "B", aDone)}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t("d.google.stepB")}{" "}
              {aDone ? null : <span className="text-xs text-[var(--color-muted)]">· {t("d.google.stepBLock")}</span>}
            </p>
          </div>
        </li>
      </ol>
      {aDone ? <ConnectedAccounts /> : null}
    </div>
  );
}

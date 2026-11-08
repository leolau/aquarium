"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AccountSecurity } from "@/components/account/AccountSecurity";
import { AppsSettings, UploadsSettings } from "@/components/settings/AppsSettings";
import { EntityGoalSection } from "@/components/settings/EntityGoalSection";
import { MenuSection } from "@/components/settings/MenuSection";
import { SettingsBackLink } from "@/components/settings/SettingsBackLink";
import {
  settingsSectionHref,
  visibleSettingsSections,
  type SettingsAccess,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { PushEnroll } from "@/components/push/PushEnroll";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { GoogleClientSetup } from "@/components/settings/GoogleClientSetup";
import { TelegramLinks } from "@/components/settings/TelegramLinks";
import { TelegramBotSetup } from "@/components/settings/TelegramBotSetup";
import { EmailMailboxes } from "@/components/settings/EmailMailboxes";
import { SqlServerConnections } from "@/components/settings/SqlServerConnections";
import { WindowsServerConnections } from "@/components/settings/WindowsServerConnections";
import { VpnConnections } from "@/components/settings/VpnConnections";
import { WhatsAppBridges } from "@/components/settings/WhatsAppBridges";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Spinner } from "@/components/ui/Spinner";
import type { EntityGoal, SessionTag } from "@/types";
import {
  applyTheme,
  DEFAULT_THEME,
  isThemeId,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeId,
} from "@/lib/theme";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT } from "@/i18n";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";
import { useConfirm } from "@/components/ui/useConfirm";

/** Tag colours — same set used in SessionModal. */
const TAG_COLORS = [
  { id: "blue", label: "Blue" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "purple", label: "Purple" },
  { id: "gray", label: "Gray" },
];

const TAG_DOT: Record<string, string> = {
  blue: "var(--color-accent)",
  red: "#ef4444",
  green: "#22c55e",
  amber: "#f59e0b",
  purple: "#a855f7",
  gray: "var(--color-muted)",
};

/**
 * The Settings page body. Without `section` it is the index: one tile per
 * section the caller may open (see `sections.ts`). With `section` it is that
 * section's detail page, under a "← All settings" link.
 */
export function SettingsView({
  section,
  entityGoal = null,
  entityGoalReadOnly = false,
  canManageMembers = true,
  canManageTools = true,
  isOwner = false,
}: {
  /** The detail page to render; omit for the index of section tiles. */
  section?: SettingsSectionId;
  entityGoal?: EntityGoal | null;
  entityGoalReadOnly?: boolean;
  /** Owner/admin may link and unlink Telegram ids; others see a note. */
  canManageMembers?: boolean;
  /** Owner/admin may change Tools & Integrations; others may only view. */
  canManageTools?: boolean;
  /** Owner: titles the own-login block "Owner account…" and sets up
   *  install-wide pieces such as the Google client. */
  isOwner?: boolean;
} = {}) {
  if (!section) {
    return <SettingsIndex access={{ canManageMembers, canManageTools }} />;
  }
  return (
    <div data-component="SettingsView" data-detail={section}>
      <SettingsBackLink />
      <SettingsSection
        section={section}
        entityGoal={entityGoal}
        entityGoalReadOnly={entityGoalReadOnly}
        canManageMembers={canManageMembers}
        isOwner={isOwner}
      />
    </div>
  );
}

function SettingsIndex({ access }: { access: SettingsAccess }) {
  const t = useT("settings");
  return (
    <nav data-component="SettingsView" aria-label={t("title")}>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visibleSettingsSections(access).map((id) => (
          <li key={id}>
            <Link
              href={settingsSectionHref(id)}
              data-section-link={id}
              className="flex h-full items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-accent)]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{t(`section.${id}`)}</span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                  {t(`section.${id}.hint`)}
                </span>
              </span>
              <span aria-hidden className="text-[var(--color-muted)]">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SettingsSection({
  section,
  entityGoal,
  entityGoalReadOnly,
  canManageMembers,
  isOwner,
}: {
  section: SettingsSectionId;
  entityGoal: EntityGoal | null;
  entityGoalReadOnly: boolean;
  canManageMembers: boolean;
  isOwner: boolean;
}) {
  const t = useT("settings");
  switch (section) {
    case "language":
      return (
        <section data-section="language">
          <h2 className="text-sm font-semibold">{t("language")}</h2>
          <p className="mb-3 text-xs text-[var(--color-muted)]">{t("languageHint")}</p>
          <LanguageSwitch />
        </section>
      );
    case "account":
      return <AccountSecurity isOwner={isOwner} />;
    case "theme":
      return <ThemeSection />;
    case "notifications":
      return <PushEnroll />;
    case "in-out":
      return <InOutSection canManageMembers={canManageMembers} isOwner={isOwner} />;
    case "uploads":
      return <UploadsSettings />;
    case "apps":
      return <AppsSettings />;
    case "menu":
      return <MenuSection />;
    case "entity-goal":
      return <EntityGoalSection goal={entityGoal} readOnly={entityGoalReadOnly} />;
    case "tags":
      return <TagsSection />;
    default:
      // tools, get-ready and upgrade have their own routes.
      return null;
  }
}

function ThemeSection() {
  const t = useT("settings");
  const [theme, setTheme] = usePersistentState<ThemeId>(
    THEME_STORAGE_KEY,
    DEFAULT_THEME,
    (raw) => (isThemeId(raw) ? raw : DEFAULT_THEME),
    (value) => value,
  );

  function choose(next: ThemeId) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <section data-section="theme">
      <h2 className="text-sm font-semibold">{t("theme")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("themeHint")}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {THEMES.map((opt) => {
          const active = opt.id === theme;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() => choose(opt.id)}
              className={`flex flex-col items-start gap-2 rounded-2xl border p-3 text-left ${
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)]"
              }`}
            >
              <span
                aria-hidden
                className="flex w-full gap-1.5"
                data-theme={opt.id}
              >
                <span className="h-6 flex-1 rounded-md bg-[var(--color-bg)]" />
                <span className="h-6 flex-1 rounded-md bg-[var(--color-surface-2)]" />
                <span className="h-6 flex-1 rounded-md bg-[var(--color-accent)]" />
              </span>
              <span className="flex items-center gap-2 text-sm font-medium">
                {opt.label}
                {active ? (
                  <span className="text-xs text-[var(--color-accent)]">
                    ✓ Active
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-[var(--color-muted)]">
                {opt.description}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ── In&Out: channels the agent talks through ────────────────────── */

function InOutSection({
  canManageMembers,
  isOwner,
}: {
  canManageMembers: boolean;
  isOwner: boolean;
}) {
  const t = useT("settings");
  return (
    <section
      id="in-out"
      data-section="in-out"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-base font-semibold">{t("inOut")}</h2>
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        Where messages, mail and calendar events come in and go out: Google
        accounts, email, private networks (VPN), SQL Server databases, Windows
        servers (PowerShell), WhatsApp
        bridges and Telegram.
      </p>
      <div className="space-y-6 border-t border-[var(--color-border)] pt-4">
        {isOwner && <GoogleClientSetup />}
        <ConnectedAccounts />
        <EmailMailboxes />
        <VpnConnections />
        <SqlServerConnections isOwner={isOwner} />
        <WindowsServerConnections />
        <WhatsAppBridges />
        <TelegramBotSetup />
        <TelegramLinks canManage={canManageMembers} />
      </div>
    </section>
  );
}

/* ── Tags management ─────────────────────────────────────────────── */

function TagsSection() {
  const { ask, dialog } = useConfirm();
  const t = useT("settings");
  const [tags, setTags] = useState<SessionTag[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState("blue");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  // A delete is a write plus a local prune; the tag it names disappears, so the
  // list is covered while it runs rather than letting a second × land on a row
  // that is about to shift.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadTags() {
    try {
      const res = await fetch("/api/chat/sessions/tags", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { tags?: SessionTag[] };
        if (body.tags) setTags(body.tags);
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void loadTags(), 0);
    return () => clearTimeout(t);
  }, []);

  async function createTag() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/sessions/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, color }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Failed to create tag.");
      }
      const body = (await res.json()) as { tag?: SessionTag };
      if (body.tag) {
        setTags((prev) =>
          prev.some((t) => t.id === body.tag!.id)
            ? prev
            : [...prev, body.tag!],
        );
      }
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tag.");
    } finally {
      setCreating(false);
    }
  }

  const create = useAction(createTag);

  async function deleteTag(tagId: string, tagName: string) {
    const ok = await ask({
      title: `Delete tag "${tagName}"?`,
      body: "This removes it from all sessions.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setError(null);
    setDeleting(tagId);
    try {
      const res = await fetch(`/api/chat/sessions/tags/${encodeURIComponent(tagId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete tag.");
      setTags((prev) => prev.filter((t) => t.id !== tagId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tag.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section data-section="tags">
      {dialog}
      <h2 className="text-sm font-semibold">{t("tags")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Define tags here, then associate them with conversations from the chat.
      </p>

      {/* Create form */}
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create.run();
            }
          }}
          placeholder="Tag name…"
          maxLength={50}
          className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
        <select
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm text-[var(--color-fg)]"
        >
          {TAG_COLORS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <ActionButton
          onAction={() => create.run()}
          disabled={creating || !name.trim()}
          className="shrink-0 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {creating ? (
            <span className="inline-flex items-center gap-2">
              <Spinner />
              Creating…
            </span>
          ) : (
            "Create"
          )}
        </ActionButton>
      </div>

      {error && (
        <p className="mb-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {/* Tag list */}
      <BusyRegion
        busy={loading || deleting !== null}
        label={deleting ? "Deleting the tag…" : "Loading your tags…"}
      >
        {tags.length === 0 && !loading ? (
          <p className="text-xs text-[var(--color-muted)]">
            No tags defined yet. Create one above.
          </p>
        ) : (
          <div className="flex min-h-6 flex-wrap gap-2">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs"
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: TAG_DOT[tag.color] ?? TAG_DOT.blue }}
                />
                <span className="text-[var(--color-fg)]">{tag.name}</span>
                {tag.session_count !== undefined && (
                  <span className="text-[var(--color-muted)]">
                    ({String(tag.session_count)})
                  </span>
                )}
                <ActionButton
                  onAction={() => deleteTag(tag.id, tag.name)}
                  className="ml-0.5 text-xs opacity-60 hover:opacity-100"
                  aria-label={`Delete tag ${tag.name}`}
                >
                  ×
                </ActionButton>
              </span>
            ))}
          </div>
        )}
      </BusyRegion>
    </section>
  );
}

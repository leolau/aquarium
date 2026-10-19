"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { usePathname } from "next/navigation";

import "@/components/coral/coral-apps";
import "./coral.css";
import { buildCoralLayout, isAppActive } from "@/components/coral/coral-registry";
import {
  parkLeadChatForMenu,
  restoreLeadChatAfterMenu,
} from "@/components/coral/coral-interlock";
import { CoralTile } from "@/components/coral/CoralPetal";
import { useChatUnreadCount } from "@/components/coral/useChatUnread";
import { useT } from "@/i18n";

const STAGGER_MS = 18;

/**
 * Coral launcher — one of the two Coral floating buttons (the lead-chat
 * button is `LeadChatHost`); design: docs/design/coral-app-framework.md.
 * A small half-pill flush with the left edge; tapping it opens a panel
 * anchored beside it with every registered app as a tile (glyph + full
 * label) in a grid, grouped into sections.
 *
 * The layout comes from the registry, so this component never names a
 * destination — apps register, the launcher renders what's registered.
 * Top-level app petals form the first grid; cluster petals become section
 * headers holding their members.
 */
export function CoralHost({
  badgeCounts = {},
}: {
  badgeCounts?: Record<string, number>;
}) {
  const t = useT("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const petals = buildCoralLayout();

  // Server-supplied badges (e.g. todos-open) plus the client-side unread
  // count — last-read state lives in this browser, so the shell can't see it.
  const chatUnread = useChatUnreadCount();
  const allBadges: Record<string, number> =
    chatUnread > 0 ? { ...badgeCounts, "chat-unread": chatUnread } : badgeCounts;

  const close = (reason: "dismiss" | "navigate") => {
    setOpen(false);
    restoreLeadChatAfterMenu();
    if (reason === "dismiss") fabRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      restoreLeadChatAfterMenu();
      fabRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Opening moves focus into the panel; arrow keys rove between tiles.
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>("a[role='menuitem']")
      ?.focus();
  }, [open]);

  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("a[role='menuitem']") ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (items.length === 0) return;
    e.preventDefault();
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next =
      current === -1
        ? 0
        : (current + (forward ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  // Stagger delays in render order: all app tiles first, then each cluster's
  // members — matching the two render passes below.
  const tileDelays = new Map<string, number>();
  let tileIndex = 0;
  for (const petal of petals) {
    if (petal.type === "app") {
      tileDelays.set(`a:${petal.app.id}`, ++tileIndex * STAGGER_MS);
    }
  }
  for (const petal of petals) {
    if (petal.type !== "cluster") continue;
    for (const member of petal.members) {
      tileDelays.set(`c:${member.id}`, ++tileIndex * STAGGER_MS);
    }
  }

  return (
    <div data-component="CoralHost">
      {open ? (
        <>
          <div
            className="coral-backdrop fixed inset-0 z-40 bg-black/60"
            onClick={() => close("dismiss")}
            aria-hidden
          />
          <div
            ref={panelRef}
            id="coral-panel"
            role="menu"
            aria-label={t("launcher")}
            onKeyDown={onPanelKeyDown}
            className="coral-panel"
          >
            <section className="coral-section coral-section--main">
              <div className="grid grid-cols-4 gap-1">
                {petals
                  .filter((p) => p.type === "app")
                  .map((petal) => {
                    if (petal.type !== "app") return null;
                    return (
                      <CoralTile
                        key={petal.app.id}
                        app={petal.app}
                        active={isAppActive(pathname, petal.app.route)}
                        badgeCount={
                          petal.app.badgeSlot
                            ? allBadges[petal.app.badgeSlot]
                            : undefined
                        }
                        delayMs={tileDelays.get(`a:${petal.app.id}`) ?? 0}
                        onClose={() => close("navigate")}
                      />
                    );
                  })}
              </div>
            </section>
            {petals
              .filter((p) => p.type === "cluster")
              .map((petal) => {
                if (petal.type !== "cluster") return null;
                return (
                  <section
                    key={petal.id}
                    className={`coral-section coral-section--${petal.id} mt-4`}
                  >
                    <h3 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      {t.has(`clusters.${petal.id}`) ? t(`clusters.${petal.id}`) : petal.label}
                    </h3>
                    <div className="grid grid-cols-4 gap-1">
                      {petal.members.map((member) => (
                        <CoralTile
                          key={member.id}
                          app={member}
                          active={isAppActive(pathname, member.route)}
                          badgeCount={
                            member.badgeSlot
                              ? allBadges[member.badgeSlot]
                              : undefined
                          }
                          delayMs={tileDelays.get(`c:${member.id}`) ?? 0}
                          onClose={() => close("navigate")}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
          </div>
        </>
      ) : null}
      <button
        ref={fabRef}
        type="button"
        onClick={() => {
          if (open) {
            close("dismiss");
          } else {
            // The menu and the lead chat shouldn't stack — park the chat;
            // close() opens it back up when the menu goes away.
            parkLeadChatForMenu();
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-controls={open ? "coral-panel" : undefined}
        aria-label={open ? t("closeMenu") : t("openMenu")}
        className="coral-fab fixed z-[60] flex h-11 w-11 items-center justify-center rounded-l-none rounded-r-full text-base text-[var(--color-accent-fg)]"
        style={{
          left: 0,
          bottom: "calc(var(--safe-bottom) + 0.75rem)",
          background:
            "linear-gradient(135deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 60%, #ff7e6b))",
        }}
      >
        <span aria-hidden>{open ? "✕" : "❋"}</span>
      </button>
    </div>
  );
}

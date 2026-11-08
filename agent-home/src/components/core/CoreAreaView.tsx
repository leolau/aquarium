"use client";

import type { ReactNode } from "react";

import { AdvancedSwitch, useAdvanced } from "@/components/system/Advanced";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n/client";
import type { Change, CoreManifestResponse } from "@/types";

/**
 * FG-20 Wave B2 — Core view (read-only, C7), Figma 32:3259.
 *
 * The permanent window on the FG-14 Core boundary the runtime agent may never
 * cross: protected paths, boundary health (`fallback_active` → the built-in
 * safe list), blocked attempts and the FG-12 change log. Core changes only
 * through the human repo/PR flow, so nothing here mutates state. File paths,
 * actors and change ids sit behind Advanced.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-component="CoreSection" className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h2>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      data-component="CoreCard"
      className="min-w-0 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      {children}
    </div>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-[var(--color-muted)]">{children}</p>
);

function BoundaryHealth({ manifest, advanced }: { manifest: CoreManifestResponse; advanced: boolean }) {
  const t = useT("system");
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("core.boundary")}</span>
        <Pill tone={manifest.fallback_active ? "warning" : "success"}>
          {manifest.fallback_active ? t("core.fallback") : t("core.protected")}
        </Pill>
        {advanced && manifest.self_protected ? <Pill tone="muted">{t("core.selfProtected")}</Pill> : null}
      </div>
      {manifest.fallback_active ? (
        <div className="mt-3">
          <InlineAlert tone="warn">{t("core.fallbackHelp")}</InlineAlert>
        </div>
      ) : null}
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        <strong className="text-[var(--color-fg)]">{t("core.paths", { count: manifest.glob_count })}</strong> ·{" "}
        {t("core.pathsBody")}
      </p>
      {advanced ? (
        <p className="mt-1 text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">
          {t("core.manifest", { path: manifest.manifest_path })}
        </p>
      ) : null}
      {manifest.globs.length > 0 ? (
        <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {manifest.globs.map((glob) => (
            <li
              key={glob}
              className="rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]"
            >
              {glob}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function CoreAreaView({
  manifest,
  changes,
  changesConfigured,
  initialAdvanced = false,
}: {
  manifest: CoreManifestResponse | null;
  changes: Change[];
  changesConfigured: boolean;
  initialAdvanced?: boolean;
}) {
  const t = useT("system");
  const [advanced, setAdvanced] = useAdvanced("core", initialAdvanced);
  return (
    <div data-component="CoreAreaView" className="flex flex-col gap-5 pb-24 lg:pb-8">
      <div className="flex justify-end">
        <AdvancedSwitch on={advanced} onChange={setAdvanced} />
      </div>
      <Section title={t("core.health")}>
        {manifest ? <BoundaryHealth manifest={manifest} advanced={advanced} /> : <Muted>{t("core.unavailable")}</Muted>}
      </Section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title={t("core.blocked")}>
          {manifest && manifest.denials.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {manifest.denials.map((denial) => (
                <li key={denial.id}>
                  <Card>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="warning">{denial.mode}</Pill>
                      {advanced ? (
                        <span className="text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">{denial.actor_user_id}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm [overflow-wrap:anywhere]">{denial.summary}</p>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <Card>
              <Muted>{t("core.noBlocked")}</Muted>
            </Card>
          )}
        </Section>

        <Section title={t("core.changelog")}>
          {!changesConfigured ? (
            <Card>
              <Muted>{t("core.changelogOff")}</Muted>
            </Card>
          ) : changes.length === 0 ? (
            <Card>
              <Muted>{t("core.noChanges")}</Muted>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {changes.map((change) => (
                <li key={change.id}>
                  <Card>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="muted">{change.mode}</Pill>
                      <Pill tone="muted">{change.target_kind}</Pill>
                      {change.reversible ? <Pill tone="muted">{t("core.reversible")}</Pill> : null}
                      {change.undone ? <Pill tone="warning">{t("core.undone")}</Pill> : null}
                      {advanced ? (
                        <span className="text-xs text-[var(--color-muted)]">{change.actor_user_id ?? "—"}</span>
                      ) : null}
                    </div>
                    {advanced ? (
                      <code className="mt-1 block text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">
                        {change.id.slice(0, 24)}
                      </code>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <p className="text-xs text-[var(--color-muted)]">{t("core.readOnly")}</p>
    </div>
  );
}

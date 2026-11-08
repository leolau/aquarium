import { CoreAreaView } from "@/components/core/CoreAreaView";
import { MobileShell } from "@/components/MobileShell";
import { LoadError } from "@/components/system/LoadError";
import { LockedState } from "@/components/system/LockedState";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { Change, CoreManifestResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * FG-20 Wave B2 — Core view. BFF: resolves the principal and reads the FG-14
 * Core-boundary projection (`/api/core/manifest`) plus the FG-12 change log
 * (`/api/comms/changes`, C2-scoped). Read-only: Core is immutable to the
 * runtime agent. Admin-only: members get a friendly locked card, not a 403.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("system");
  const shell = {
    title: t("cards.core.name"),
    subtitle: t("core.subtitle"),
    info: <InfoTip label={t("core.info")}>{t("core.infoBody")}</InfoTip>,
    wide: true,
  };

  if (!canAdminister(principal)) {
    return (
      <MobileShell {...shell} subtitle={undefined} info={undefined}>
        <LockedState
          title={t("lockedPage.core.title")}
          body={t("lockedPage.core.body")}
          hint={t("lockedPage.hint")}
          back={t("lockedPage.back")}
        />
      </MobileShell>
    );
  }

  let manifest: CoreManifestResponse | null = null;
  let changes: Change[] = [];
  let changesConfigured = false;
  let error: string | null = null;

  try {
    const client = await apiClientForRequest();
    manifest = await client.coreManifest(50);
    try {
      const changesResp = await client.changes();
      changesConfigured = changesResp.configured;
      changes = changesResp.changes ?? [];
    } catch {
      changesConfigured = false;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load the Core view";
  }

  return (
    <MobileShell {...shell}>
      {error ? (
        <LoadError component="CoreError" title={t("core.loadError")} details={error} />
      ) : (
        <CoreAreaView manifest={manifest} changes={changes} changesConfigured={changesConfigured} />
      )}
    </MobileShell>
  );
}

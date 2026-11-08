import { MobileShell } from "@/components/MobileShell";
import { LoadError } from "@/components/system/LoadError";
import { LockedState } from "@/components/system/LockedState";
import { WebviewConsole } from "@/components/webview/WebviewConsole";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { WebviewSession } from "@/types";

// Reads the live principal (cookie) + the caller's ephemeral webview session
// per request — never at build time.
export const dynamic = "force-dynamic";

/**
 * FG-20 Wave C2 — the agent-webview tab (FG-17b). BFF: the server resolves the
 * principal and loads the caller's open webview session (or the default-deny
 * empty state) from the Python API, then hands it to the interactive
 * {@link WebviewConsole}. Opening/closing sessions, requesting actions, and
 * resolving C6 approvals all route back through `/api/webview/*` to the
 * consent-gated (C6), per-user-isolated (C2), traced (C8) Python endpoints.
 * Admin-only: members get a friendly locked card instead.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("system");
  const title = t("cards.webview.name");

  if (!canAdminister(principal)) {
    return (
      <MobileShell title={title}>
        <LockedState
          title={t("lockedPage.webview.title")}
          body={t("lockedPage.webview.body")}
          hint={t("lockedPage.hint")}
          back={t("lockedPage.back")}
        />
      </MobileShell>
    );
  }

  let configured = false;
  let session: WebviewSession | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    const resp = await client.getWebviewSession();
    configured = resp.configured;
    session = resp.session;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load the webview";
  }

  return (
    <MobileShell title={title} subtitle={t("webview.subtitle")}>
      {error ? (
        <LoadError component="WebviewError" title={t("webview.loadError")} details={error} />
      ) : (
        <div className="pb-24 lg:pb-8">
          <WebviewConsole initialConfigured={configured} initialSession={session} />
        </div>
      )}
    </MobileShell>
  );
}

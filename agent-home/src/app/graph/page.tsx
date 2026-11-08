import { GtsCentreView } from "@/components/gts/GtsCentreView";
import { MobileShell } from "@/components/MobileShell";
import { LoadError } from "@/components/system/LoadError";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { GtsGraphResponse } from "@/types";

// Reads the live principal (cookie) + the C2-scoped GTS graph from the Python
// API per request — never at build time.
export const dynamic = "force-dynamic";

const EMPTY_GRAPH: GtsGraphResponse = {
  configured: false,
  goals: [],
  tasks: [],
  skills: [],
  task_goals: [],
  task_skills: [],
  assignment: { enabled: true, scheme: "per-user" },
};

/**
 * FG-20 Wave B1 — Graph (formerly GTS Centre). BFF: the server resolves the principal, calls
 * the Python API `/api/gts/graph` (C2 + item_grants RLS enforced upstream), and
 * renders the mobile-first read-only graph. The browser never touches Supabase.
 */
export default async function Page() {
  await requirePrincipal();
  const t = await getT("system");

  let graph = EMPTY_GRAPH;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    graph = await client.gtsGraph();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load the GTS graph";
  }

  return (
    <MobileShell
      title={t("cards.graph.name")}
      subtitle={t("graph.subtitle")}
      info={<InfoTip label={t("graph.info")}>{t("graph.infoBody")}</InfoTip>}
      wide
    >
      {error ? (
        <LoadError component="GtsError" title={t("graph.loadError")} details={error} />
      ) : (
        <GtsCentreView graph={graph} />
      )}
    </MobileShell>
  );
}

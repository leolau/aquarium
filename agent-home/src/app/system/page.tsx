import { MobileShell } from "@/components/MobileShell";
import { HUB_ICONS, type HubCard, type HubGroup } from "@/components/system/SystemHub";
import { SystemHubAdvanced } from "@/components/system/SystemHubAdvanced";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/session";
import { getHiddenApps } from "@/lib/nav/hidden-apps";
import { withAdminOnly } from "@/lib/nav/menu-access";

export const dynamic = "force-dynamic";

/** A card's count line; any failure leaves it null so the card shows "—" but stays linked. */
async function meta(load: () => Promise<string>): Promise<string | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/**
 * `/system` — the System hub (Figma "Inner — System hub" 20:2060). One card
 * per System destination, in two groups; each card's counts load on their
 * own. Profiles disappears for members (it is menu-locked) and Skills when
 * the role may not see skills (Settings → Skills permissions); Core and the agent web browser are hidden (their URLs show a friendly "for admins" page).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  const t = await getT("system");
  const admin = canAdminister(principal);
  const session = await readSession();
  const hidden = withAdminOnly(
    principal.role,
    await getHiddenApps(principal, session?.hermesToken, session?.profile).catch(() => ["skills"]),
  );
  const client = await apiClientForRequest();

  const [profiles, skills, memory, graph, models, tools, core, webview, data] = await Promise.all([
    meta(async () => {
      const [infos, sugg] = await Promise.all([client.profileInfos(), client.profileSuggestions()]);
      return t("cards.profiles.meta", { profiles: infos.profiles.length, suggestions: sugg.suggestions.length });
    }),
    meta(async () => {
      const list = await client.skillList();
      return t("cards.skills.meta", { installed: list.length, enabled: list.filter((s) => s.enabled).length });
    }),
    meta(async () => {
      const s = await client.memorySummary();
      return t("cards.memory.meta", { memories: s.totals.memories, documents: s.totals.documents });
    }),
    meta(async () => {
      const g = await client.gtsGraph();
      if (!g.configured) throw new Error("not configured");
      return t("cards.graph.meta", { goals: g.goals.length, tasks: g.tasks.length });
    }),
    meta(async () => t("cards.models.meta", { model: (await client.modelInfo()).model })),
    meta(async () => {
      const r = await client.tools();
      return t("cards.tools.meta", { apps: r.tools.length, enabled: r.tools.filter((x) => x.status === "enabled").length });
    }),
    admin
      ? meta(async () => {
          const m = await client.coreManifest(50);
          return t("cards.core.meta", {
            state: m.fallback_active ? t("cards.core.fallback") : t("cards.core.healthy"),
            denials: m.denials.length,
          });
        })
      : Promise.resolve(null),
    admin
      ? meta(async () => {
          const w = await client.getWebviewSession();
          return t("cards.webview.meta", { state: w.session ? t("cards.webview.open") : t("cards.webview.idle") });
        })
      : Promise.resolve(null),
    meta(async () => {
      const { sources } = await client.dataSources();
      return t("cards.data.meta", { sources: sources.length, drafts: sources.filter((x) => x.status === "draft" && x.access === "manage").length });
    }),
  ]);

  const card = (id: string, href: string, value: string | null, extra: Partial<HubCard> = {}): HubCard => ({
    id,
    href,
    name: t(`cards.${id}.name`),
    desc: t(`cards.${id}.desc`),
    meta: value,
    icon: HUB_ICONS[id],
    ...extra,
  });
  const visible = (c: HubCard) => !hidden.includes(c.id);

  const groups: HubGroup[] = [
    {
      id: "knowledge",
      label: t("groups.knowledge"),
      cards: [
        card("profiles", "/profiles", profiles),
        card("skills", "/skills", skills),
        card("memory", "/memory", memory),
        card("data", "/data", data),
        card("graph", "/graph", graph, { advanced: true }),
      ].filter(visible),
    },
    {
      id: "running",
      label: t("groups.running"),
      cards: [
        card("models", "/models", models),
        card("tools", "/tools", tools),
        ...(admin
          ? [card("core", "/core", core, { adminChip: true, advanced: true }), card("webview", "/webview", webview, { adminChip: true, advanced: true })]
          : []),
      ].filter(visible),
    },
  ];

  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("info")}>{t("infoBody")}</InfoTip>}
      wide
    >
      <SystemHubAdvanced
        groups={groups}
        advancedHelp={t("hubAdvancedHelp")}
        adminNote={admin ? t("adminView") : null}
        unknown={t("unknown")}
        lockedLabel={t("locked")}
        lockedBody={t("lockedBody")}
        settingsLead={t("settingsLead")}
        settingsLink={t("settingsLink")}
      />
    </MobileShell>
  );
}

import { AquariumBackdrop } from "@/components/aquarium/AquariumBackdrop";
import { AquariumLoader } from "@/components/brand/AquariumLoader";
import { getT } from "@/i18n/server";

/**
 * Route-level loading UI for the **Aquarium dashboard**: full-bleed like the
 * page (no shell), so the tank paints on tap instead of the signed-in shell
 * flashing before the dashboard replaces it.
 */
export default async function Loading() {
  const t = await getT("aquarium");
  return (
    <div
      data-component="AquariumLoading"
      aria-busy="true"
      className="fixed inset-0 z-0 flex flex-col items-center justify-center gap-4 overflow-hidden bg-[#053467] text-white"
    >
      <AquariumBackdrop />
      <div className="relative flex flex-col items-center gap-4">
        <AquariumLoader size={64} label={t("loading")} />
        <p className="text-sm text-white/80">{t("loading")}</p>
      </div>
    </div>
  );
}

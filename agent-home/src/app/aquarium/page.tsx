import { AquariumView } from "@/components/aquarium/AquariumView";
import { requirePrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/**
 * FG-35 — the Aquarium: every person on the box as a sea creature, trailed by
 * their profiles. Full-bleed (no shell); the view polls `GET /api/aquarium`.
 */
export default async function Page() {
  await requirePrincipal();
  return <AquariumView />;
}

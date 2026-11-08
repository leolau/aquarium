import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { getPrincipal } from "@/lib/auth/principal";

/** App-wide 404: the shell (launcher only for signed-in people) and a way back. */
export default async function NotFound() {
  const [t, principal] = await Promise.all([getT("errors"), getPrincipal()]);
  return (
    <MobileShell title={t("notFoundTitle")} showCoral={principal !== null}>
      <ErrorState kind="notFound" />
    </MobileShell>
  );
}

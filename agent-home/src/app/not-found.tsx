import { AuthLayout } from "@/components/auth/AuthLayout";
import { MobileShell } from "@/components/MobileShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { getT } from "@/i18n/server";
import { getPrincipal } from "@/lib/auth/principal";

/**
 * App-wide 404. Signed-in people get the normal shell (launcher, Back to the
 * logical parent of the broken address); signed-out visitors get the auth
 * layout with Sign in instead of Home, and no launcher.
 */
export default async function NotFound() {
  const [t, principal] = await Promise.all([getT("errors"), getPrincipal()]);
  if (principal === null) {
    return (
      <AuthLayout wide component="NotFoundSignedOut">
        <ErrorState kind="notFound" signedOut />
      </AuthLayout>
    );
  }
  return (
    <MobileShell title={t("notFoundTitle")}>
      <ErrorState kind="notFound" />
    </MobileShell>
  );
}

import { AuthLayout } from "@/components/auth/AuthLayout";
import { RouteLoading } from "@/components/ui/RouteLoading";

/**
 * Route-level loading UI for **Activate your account**.
 *
 * Present so this signed-out route doesn't fall through to the root loader —
 * a signed-out visitor should never see the app shell or launcher flash
 * before the form. Same auth layout as the page, loader only.
 */
export default function Loading() {
  return (
    <AuthLayout>
      <RouteLoading />
    </AuthLayout>
  );
}

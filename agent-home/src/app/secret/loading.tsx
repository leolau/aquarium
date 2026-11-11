import { AuthLayout } from "@/components/auth/AuthLayout";
import { RouteLoading } from "@/components/ui/RouteLoading";

/**
 * Route-level loading UI for a one-time **secret link** (FG-37). The person
 * opening it is signed out, so this keeps the signed-out auth layout instead of
 * the root skeleton and its launcher.
 */
export default function Loading() {
  return (
    <AuthLayout>
      <RouteLoading />
    </AuthLayout>
  );
}

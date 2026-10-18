import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { useAdminRole } from "@/contexts/useAdminRole";

/** Renders its children only for owners/admins (and no-login operators). */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  return useAdminRole() === "admin" ? <>{children}</> : null;
}

/** Wraps an owner/admin-only page: members and viewers who open its URL get a
 * short explanation instead of a page full of 403 errors. */
export function AdminOnlyPage({ children }: { children: React.ReactNode }) {
  const state = useAdminRole();
  if (state === "loading") {
    return (
      <div
        data-component="AdminOnlyPage"
        className="flex flex-1 items-center justify-center py-12"
        aria-busy="true"
      >
        <Spinner />
      </div>
    );
  }
  if (state === "not-admin") {
    return (
      <Card data-component="AdminOnlyPage" className="m-4">
        <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Only the owner or an admin can open this page.
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

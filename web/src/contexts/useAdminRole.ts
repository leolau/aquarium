import { useContext } from "react";
import type { AdminRoleState } from "@/lib/admin-role";
import { AdminRoleContext } from "./admin-role-context";

export function useAdminRole(): AdminRoleState {
  const ctx = useContext(AdminRoleContext);
  if (!ctx) {
    throw new Error("useAdminRole must be used within an AdminRoleProvider");
  }
  return ctx;
}

/** True only once the server confirmed owner/admin (or no-login operator). */
export function useIsAdmin(): boolean {
  return useAdminRole() === "admin";
}

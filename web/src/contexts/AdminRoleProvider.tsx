import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  adminStateFromError,
  adminStateFromWhoami,
  type AdminRoleState,
} from "@/lib/admin-role";
import { AdminRoleContext } from "./admin-role-context";

export function AdminRoleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AdminRoleState>("loading");

  useEffect(() => {
    let cancelled = false;
    api
      .getCommsWhoami()
      .then((resp) => {
        if (!cancelled) setState(adminStateFromWhoami(resp));
      })
      .catch((err) => {
        if (!cancelled) setState(adminStateFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AdminRoleContext.Provider value={state}>
      {children}
    </AdminRoleContext.Provider>
  );
}

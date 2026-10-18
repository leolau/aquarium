import { createContext } from "react";
import type { AdminRoleState } from "@/lib/admin-role";

export const AdminRoleContext = createContext<AdminRoleState | null>(null);

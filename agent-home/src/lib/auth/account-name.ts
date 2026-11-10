import type { Principal } from "@/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The name the account menu shows: the principal's display name, else its
 * user id when that is a readable handle (e.g. `leo_owner`), never a UUID.
 */
export function accountName(principal: Pick<Principal, "display" | "user_id">): string | null {
  const display = principal.display?.trim();
  if (display) return display;
  const id = principal.user_id?.trim();
  return id && !UUID.test(id) ? id : null;
}

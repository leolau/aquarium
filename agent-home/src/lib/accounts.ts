/** Settings › Accounts (FG-38 P2b): whose each mailbox, calendar and WhatsApp phone is. */
export const ACCOUNT_SURFACES = ["email", "calendar", "whatsapp"] as const;
export type AccountSurface = (typeof ACCOUNT_SURFACES)[number];

/** Why an account has its person, highest rule first. */
export type AccountOwnerSource = "settings" | "config" | "connected" | "install_owner";

export interface AccountRow {
  surface: AccountSurface;
  account: string;
  label: string;
  enabled: boolean;
  owner_user_id: string | null;
  source: AccountOwnerSource;
  settings_owner: string | null;
  config_owner: string | null;
  connected_owner: string | null;
  set_by: string | null;
  set_at: string | null;
}

export interface AccountPerson {
  user_id: string;
  display: string;
  role: string;
  active: boolean;
}

export interface AccountsState {
  accounts: AccountRow[];
  people: AccountPerson[];
  unreadable: string[];
}

/** Whose the account would be with no Settings choice: the next rule down. */
export function automaticOwner(row: AccountRow): string | null {
  return row.config_owner ?? row.connected_owner ?? null;
}

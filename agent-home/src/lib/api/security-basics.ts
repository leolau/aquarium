/** Get ready → Security basics: shapes returned by `/api/security-basics` (hermes_cli/security_basics.py). */
export type SecurityCheckId =
  | "tls"
  | "ssh"
  | "updates"
  | "ports"
  | "doctor"
  | "tools_user"
  | "two_factor";

export type SecurityCheckStatus = "ok" | "attention" | "unknown" | "unavailable";

export type SecurityCheck = {
  id: SecurityCheckId;
  status: SecurityCheckStatus;
  facts: Record<string, unknown>;
};

export type SecurityBasicsResult = {
  checked_at: string | null;
  status: "done" | "attention" | "not_started";
  passed: number;
  total: number;
  /** "ok", or why the root check helper gave no answer (missing, refused, busy, timeout, bad_output). */
  helper: string;
  checks: SecurityCheck[];
  running?: boolean;
};

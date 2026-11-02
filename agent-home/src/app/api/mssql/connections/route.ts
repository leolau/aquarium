/**
 * GET /api/mssql/connections — the caller's own SQL Server connections.
 * Hermes scopes the list to the signed-in person and never returns a password.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.mssqlConnections());
  } catch (err) {
    return hermesError(err);
  }
}
